# PRD: ProofLoop 新流程 — Propose → Planning → Execute → Review → PROJECT_READY

> 本文件是 ProofLoop 的产品权威（Product Authority）。它覆盖此前以
> Admission / Receipt Chain / Manifest credential / Context Gate / `stage next` /
> Stage Gate / legacy currentness-recovery 驱动的旧流程描述，不继承旧流程正文、历史路线或旧验收记录。
> 旧流程控制语义整体退役，只抽取与业务无关的机械安全原语（root/path、Git/worktree、process、
> protected scope、ID/schema 校验、replan-impact 分类）在新流程中复用。
>
> 状态：CONFIRMED（用户已确认整改范围；具体技术落地见 `tech-spec/` 与对应 Contract/Skill）。

## 1. One-sentence description

把 ProofLoop 重构为按 Delivery cycle 重复运行的四阶段自动流水线：

```text
Propose / 规划 (HITL)
→ Planning (Automated)
→ Execute (Automated)
→ Review (Automated)
→ PROJECT_READY
```

Propose 由 PM + Agent 建立 Product Authority（`PRD.md`）与 Technical Authority Pack（`tech-spec/`）；`PROPOSE_READY` 后，Planning/SPV 负责把 PRD intent 闭合到 Technical Authority、Project Stage Map 与 candidate Plan。只有 `PLAN_READY` / `PLAN_ACCEPTANCE` 之后，accepted Plan 才作为执行 instruction；Execute、CV、Review 以 accepted Plan + Technical Authority Pack + current operational reality 为规范依据。Brain 是 PM-facing control plane；MES operational transaction layer 负责完整 durable operational execution state / record / traceability 的物化、安全写回与关系闭合，`status` 是 MES 对 Brain / Agent / PM 的最小默认暴露面。MES 与 status 都不拥有 Product/Technical Authority；MES 也不拥有 route/dispatch/reasoning。
每个 Delivery cycle 在 `PROJECT_READY` 处关闭自己的 planned delivery set；该 terminal 是可追溯的历史事实，不是仓库永久终态。`PROJECT_READY` 之后出现新的实质工作、scope 增量或产品 intent 变化时，Brain 从 `Propose` 开始新的完整 cycle。

## 2. Background and problem

- **Current problem:** 旧 ProofLoop 以 Admission / Receipt Chain / Manifest credential /
  Context Gate / `stage next` / Stage Gate 驱动流程，存在第二套凭证链证明"某件事已合法发生"，
  加上 per-Task Runtime `Primary Next Action` 与整本 Manifest digest currentness，
  使局部返工连坐、恢复依赖凭证链、Brain 无法脱离旧 Runtime 推导恢复控制。
- **Why it matters now:** 流程需要在多 Stage / 多 Slice 下稳定 AFK 运行，要求
  单一 operational state（MES）、最小状态暴露（status）、由所选 Host Role Agent 文档承载 role procedure、由 Capability Skill 提供可复用技术方法、由 Brain 决定 route/dispatch/recovery，不再依赖第二套凭证合法性来源。
- **Desired change:** 采用四阶段生命周期；由 accepted Thin Plan + MES operational facts +
  structured Result/Finding + Git/canonical facts 表达运行事实；旧业务控制模型整体退役，
  机械安全原语抽取复用。
- **Current workaround or alternative:** 继续维护旧 Receipt/Gate 链并为新流程建
  compatibility layer。该方案已确认不可取：不建立 compatibility layer，也不保留双权威。
- **MES integrity risk（conditional mechanism）:** S06 EXECUTE 期间 MES durable write/recovery path 曾出现 partial-replace、fact-set drift 与 binding mismatch，当时以冻结真实写入口并完成 ownership / transaction / binding / recovery safety 整改闭合。当同类 integrity incident 再次成立时，必须在继续受影响 Stage 的 NORMAL Execute/Review 前先冻结写入口，并完成同样的整改与受控恢复；该机制不声明任何 Stage 当前仍处于 hard-freeze。
## 3. Target users and roles

| Role | Description | Key needs |
|---|---|---|
| PM / ProofLoop 使用者 | 在 ProofLoop 项目中提出需求并验收结果 | Propose 阶段参与决策；`PROPOSE_READY` 后 AFK；终态只收 `PROJECT_READY` 提醒并自行做最终产品验收 |
| Brain | 唯一 cross-phase route / dispatch / recovery owner | 依据 durable facts、workflow state 与 guards 决定合法 action / transition（route / dispatch / recover）；workflow 只约束允许的操作，不规定模型 reasoning 步骤或每 turn 强制循环 |
| Planner（runtime role） | 基于 canonical Authority + current code reality 生成/修订 Stage → Slice → Task | 由所选 Host 的 Planner Agent 文档内嵌 Planning procedure，按需加载 capability Skill；不修改 canonical Authority |
| SPV（stage-plan-verifier） | 对候选 Thin Plan 做只读独立 falsification | 全量 structural closure + high-risk edge counterexample；输出 `PLAN_READY | FINDINGS | BLOCKED` |
| Worker | 在同一 Slice lane 内逐 Task 实现/恢复，或执行 bounded repair | 每 Task 只 fresh-read 由 Execute 投影的 current Task JIT input；Task Result 写 MES；完成 self-check 后返回 `SLICE_CANDIDATE_READY` |
| Code Verifier（CV） | 对 Slice candidate 做只读独立反驳验证 | 读取 accepted Plan、tech-spec/acceptance、candidate Git ref/diff、real code/tests；输出 `PASS | FINDINGS | BLOCKED` |
| Stage Reviewer | 对集成后的 Stage 做三轴只读独立评审 | 从 accepted Plan、tech-spec 与 integrated reality 自行重建 Outcome → Composition → Authority；PASS 后绑定 snapshot 产生 `STAGE_ACCEPTED` |
| Subagent host runtime | Agent/session/process 宿主控制平面 | Subagent host dispatch / lifecycle / transport；不承担 ProofLoop business authority 或 Planning/Review 判断 |
| MES operational transaction layer | 唯一 normal durable operational state mutator 与 persistence-safety owner | 读取/校验当前 MES state，materialize facts/relations，保留无关历史，执行幂等与完整结果校验并原子持久化 | 不做 Product/Technical reasoning，不生成 next action，不 route/dispatch，不复制 Skill/Authority，不建立第二 state machine/store |
## 4. User scenarios

- **S1 建立 Authority：** PM 与 Agent 通过 `ai-structured-prd` →（按需 `prd-to-tech-design-prep`）→
  `prd-to-ai-architecture` 形成 `PRD.md` Product Authority 与 `tech-spec/` Technical Authority Pack；最终一次 `PROPOSE_READY`。
- **S2 自动规划：** Brain 从 MES status 看到 `<stage> / PLANNING / required_skill=proofloop-plan` observation，按所选 Host 启动对应 Planner Agent；
  Planner 读取 PRD + tech-spec + current code reality，完成 Product→Technical handoff；Plan/Map 只引用 tech-spec，SPV 独立 falsify 后收敛为
  `PLAN_READY | FINDINGS | BLOCKED`。
- **S3 Slice 执行：** Execute 以 Vertical Slice Execution Lane 为自治单元：one Slice =
  one Worker lifecycle + one isolated worktree + one logical Worker lane；Brain running `proofloop-execute` 读取完整 accepted Plan，逐 Step 选择并投影当前 dependency-ready Task，Worker 只解决当前 Task 的 HOW；
  Slice 全部 Task 完成且 self-check 后 `SLICE_CANDIDATE_READY`；fresh CV 输出
  `PASS | FINDINGS | BLOCKED`。
- **S4 集成：** CV PASS 只是 `READY_TO_INTEGRATE`；Integration 成功才是 `INTEGRATED`；
  integration finding → Brain；worktree cleanup 显式执行，cleanup failure 不回退 `INTEGRATED`。
- **S5 Stage Review：** 全部 Slice `INTEGRATED` 后，fresh runtime Review Agent 执行
  Outcome / Composition / Authority 三轴；三轴 PASS 且绑定当前 integrated snapshot →
  `STAGE_ACCEPTED`。
- **S6 项目终态：** 当前 Delivery cycle 的 all planned Stages = `STAGE_ACCEPTED` → 产生该 cycle 的 `PROJECT_READY`；
  MES/status 提醒 PM "Project ready"；PM 自行做最终产品验收，不设 Project Reviewer/Gate。
- **S7 异常与恢复：** verifier finding 一律先回 Brain；Brain 分类后 route
  （implementation→repair、plan→Replan、authority gap→Propose、technical unknown→Research/Prototype、
  runtime→诊断）；Agent 丢失后从 MES + Git + structured Result/Finding + canonical facts 恢复。
- **S8 局部返工不连坐：** Slice 内 Replan 按影响范围分级（Task-local / Slice-wide）；
  已完成且未受影响的 Slice/Task 证明保持有效（详见 FR-013）。
- **S9 重复交付循环：** 历史 `PROJECT_READY` 存在时，用户提出新的实质工作或 scope 增量，Brain 先进入 `Propose`；新 cycle 仍按 Propose → Planning → Execute → Review → `PROJECT_READY` 完成，历史 terminal 保持有效。

- **S10 S06 integrity freeze/recovery：** 当 MES durable state 出现 fact-loss 或 binding mismatch 时，Brain 立即退出 NORMAL S06 Execute/Review 路由并冻结真实写入口；保留错误历史并完成 forensic/audit，再经 Propose/Authority correction、Planning/SPV 与隔离整改建立合法 maintenance/recovery seam，最后基于 fresh rehydrate 与 impact analysis 决定 S06 resume / replan / restart。
## 5. Product goals

- **G1 四阶段生命周期：** 每个 Delivery cycle 都按 Propose → Planning → Execute → Review → PROJECT_READY 完整闭环。
- **G2 分阶段 Authority：** Propose 维护 Product Authority（PRD）与 Technical Authority Pack（Architecture / Contracts / Acceptance）；`PLAN_READY` 后 downstream normative truth 仅为 tech-spec Pack。
- **G3 单一 operational state：** MES 是执行事实唯一来源；status 是最小默认暴露面。
- **G4 Brain 是 control plane：** Brain 是唯一 cross-phase route / dispatch / recovery owner；
- **G4 Brain 是 control plane：** Brain 是唯一 cross-phase route / dispatch / recovery owner；所选 Host Role Agent 文档拥有对应 role method，capability Skill 只提供可复用技术方法；canonical facts / Result / Finding / Git 决定什么是真的。
- **G5 AFK 自动流水线：** `PROPOSE_READY` 后 PM 不参与普通 Planning / Execute / Review / Repair；
  `HUMAN_REQUIRED` 默认不主动叫醒 PM，受影响工作沿真实 dependency graph 局部暂停。
- **G6 局部可返工：** Slice-level proof binding：一个 Slice 的返工不使无关 Slice 证明失效。
- **G7 机械安全保留：** root/path、Git/worktree、process、protected scope、ID/schema、
  replan-impact 等机械原语抽取复用，不因旧业务模型退役而丢失。
- **G8 可重复交付：** 历史 terminal 按自身 delivery basis 保持可验证；新的实质工作不绕过 Propose，且新的 current cycle 可产生独立 `PROJECT_READY`。

- **G9 安全 durable operational state：** Brain 只发起/授权 semantic event，MES transaction layer 负责完整 durable materialization、binding/关系校验、幂等和原子持久化；已知错误历史保持可审计但不授权 current state，MES 被冻结时可以走独立合法 maintenance/recovery seam。
## 6. Success metrics

- 从 `PROPOSE_READY` 到 `PROJECT_READY` 的任何合法主流程路径，都不依赖 Admission、
  Receipt Chain、Manifest credential、Context Gate、`stage next`、Stage Gate 或 legacy
  currentness/recovery。
- Brain 仅凭 MES status observation + 所选 Host Agent procedure + canonical facts / Result / Finding / Git reality 即可恢复控制；不消费 Runtime 推导的 Primary Next Action。
- Agent 丢失后不依赖旧 conversation/session 即可恢复流程。
- 任一 Slice 的 Task-local Replan 只影响该 Task 及受影响后续 Task；Slice-wide Replan
  只影响该 Slice 及其依赖者；已完成且未受影响的 Slice/Task 证明保持有效。
- `proofloop status` 提供最小只读 projection；一级视图只显示 scope/phase/Skill + 非零异常计数，MES 不输出“建议下一步”；完整 operational write-back、丰富 detail/aggregation 属于后续显式实现任务。
- `PROJECT_READY` 后的新实质工作总是重新进入 Propose；历史 terminal 与后续 cycle 的 terminal 可同时按各自 planned set / delivery basis 验证，且 status 只观察当前 operational cycle。
- 全仓 active source / Skill / Brain 文档无 legacy business-control 引用残留（迁移历史段
  显式标记 Historical/legacy 且不形成 route）。

## 7. Primary user flow

1. PM 通过 `ai-structured-prd` 建立 PRD（Product Authority）；需要产品级技术澄清时按需使用
   `prd-to-ai-architecture` 形成 Architecture / Contracts / Acceptance Technical Authority Pack；最终一次 `PROPOSE_READY`。
2. Brain 依据 MES status observation（当前 phase 与 required_skill）从所选 Host Agent 文档启动对应流程，不把 status 当作 route authority。
3. Planning：所选 Host 的 Planner Agent 先执行 MAP CHECK → BIND → TRACE → COMPOSE SLICES → VALIDATE SLICE TOPOLOGY → DECOMPOSE TASKS BY SLICE → RECONCILE → CLOSE → FREEZE，读取 PRD + tech-spec + current code reality，产出 Stage → Slice → Task Thin Plan；
   Thin Plan 包含 goals、dependencies、semantic scope、code anchors、verification refs、done/stop conditions 和小粒度 tech-spec refs；SPV 只读验证 Product→Technical closure；
   `PLAN_READY` durable 后，accepted Plan 成为 execution instruction，MES status 切到 EXECUTE。
4. Execute：dependency-ready Slice lane 启动 Worker（one worktree、one tab）；Brain running `proofloop-execute`
   读取完整 accepted Plan，逐 Step 选择当前 dependency-ready Task 并把该 Task 的 JIT input 投影给同一 Worker；Worker 只 fresh-read 当前 Task 的 JIT input 与 bound refs，解决当前 Task 的 HOW 并把 Task Result 写入 MES；self-check 后
   `SLICE_CANDIDATE_READY`；fresh CV 读取 accepted Plan + tech-spec + candidate/diff/code/tests，输出 `PASS | FINDINGS | BLOCKED`。
5. CV PASS → `READY_TO_INTEGRATE`；Brain/Host 做 Integration → `INTEGRATED` → cleanup；
   全部 planned Slices `INTEGRATED` → `EXECUTION_READY_FOR_REVIEW`。
6. Review：fresh runtime Review Agent 加载 `stage-reviewer`，从 accepted Plan + tech-spec refs +
   integrated snapshot / MES / code reality 自行重建并执行 Outcome → Composition → Authority 三轴；三轴 PASS
   且绑定当前 integrated snapshot → `STAGE_ACCEPTED` 写入 MES。
7. 当前 Delivery cycle 的 all planned Stages = `STAGE_ACCEPTED` → MES 写入该 cycle 的 `PROJECT_READY`，status 提醒 PM；
   PM 自行做最终产品验收；历史 terminal 仍按自身 planned set / delivery basis 保持可验证。
8. 异常路径：verifier finding → Brain；Brain 分类并 route（repair / Replan / Propose /
   Research/Prototype / 诊断）；Agent 丢失 → MES + Git + Result/Finding rehydrate。

9. 若用户在任一历史 `PROJECT_READY` 之后提出新的实质工作、scope 增量或产品 intent 变化，Brain 将其作为新 Routing Boundary 进入 Propose；不得直接复用历史 terminal 进入 Planning/Execute。
## 8. Functional requirements

### FR-001: 四阶段生命周期

- **Description:** 每个 Delivery cycle 的主流程固定为 Propose → Planning → Execute → Review → PROJECT_READY。
- **User story:** As a ProofLoop user, I want one four-phase flow, so that every project follows
  the same lifecycle from authority to project-ready.
- **Acceptance criteria:**
  - Propose 只产出 PRD Product Authority、Architecture/Contracts/Acceptance Technical Authority Pack 与一次 `PROPOSE_READY`；不制造独立 pipeline gate。
  - Planning 产出 accepted Thin Plan（`PLAN_READY`），不复制 Authority 正文。
  - Execute 以 Slice lane 推进至 `INTEGRATED` / `EXECUTION_READY_FOR_REVIEW`。
  - Review 产出 `STAGE_ACCEPTED`（三轴 PASS + snapshot binding）。
  - 当前 cycle 的 all planned Stages accepted → 产生该 cycle 的 `PROJECT_READY`；无 Project Reviewer / Gate / Acceptance phase。
- **Status:** confirmed

### FR-002: Canonical Authority Pack

- **Description:** canonical Authority 按阶段分层：`PRD.md` 是 Product Authority；
  `tech-spec/architecture.md`（含 Hard Parts / Forbidden Shortcuts 与 ADR）、`tech-spec/contracts.md`、
  `tech-spec/acceptance.md` 组成 Technical Authority Pack。`PROPOSE_READY` 前 Planning/SPV 可同时读取 PRD 与 tech-spec；
  `PLAN_READY` / `PLAN_ACCEPTANCE` 后，tech-spec Pack 是 downstream 唯一规范 Authority，accepted Plan 只是 execution instruction。
  `tech-spec/process-discipline-matrix.md` 仅作为流程纪律索引，不独立构成 Authority；Hard Part
  风险、禁止捷径、最低实现和残余风险只在 Architecture Authority 中维护。
- **User story:** As a PM, I want one normative owner per decision, so that downstream never
  resolves authority from working material.
- **Acceptance criteria:**
  - 一个 normative decision 只有一个 canonical owner。
  - Working Material / root `CONTEXT.md` 不成为 downstream Authority；Planning / Execute / Review 明确禁止把它当 Authority 读取。
  - Planning/SPV 可以读取 PRD + tech-spec；`PLAN_READY` 前必须完成 relevant PRD intent → tech-spec representation → Map/Plan closure。
  - `delivery/project-stage-map.md`、candidate/accepted Plan 与 downstream Work Packet 的 `authority_refs` 只指向 `tech-spec/architecture.md`、`tech-spec/contracts.md`、`tech-spec/acceptance.md`。
  - `PLAN_READY` 后 Execute/CV/Review 可以仅依据 accepted Plan + tech-spec + current reality 实现和验证，不把 PRD 作为正常 Authority 输入。
  - PRD 默认不生成 execution Stage candidates；只有产品明确规定交付顺序时写成 Product Delivery Constraint。
  - superseded 的旧 tech-spec 文件名不继续承担 downstream Authority；不新增 Authority 文件，也不制造新 Authority/ReceiptType。
- **Status:** confirmed

### FR-003: MES + status

- **Description:** MES 是内部执行管理层，保存/索引 accepted Plan、Work/Dispatch、Result、Finding、异常、Git candidate/integration ref、Review result、PROJECT_READY 等 operational facts；唯一 MES operational transaction layer 负责读取当前 durable state、materialize semantic event、闭合关系、保留无关历史、执行幂等与完整结果校验并原子持久化；`status` 是 MES 对 Brain / Agent / PM 的最小默认暴露面。
- **User story:** As a Brain, I want semantic decisions to become safe durable operational facts without snapshot assembly, so that current state remains complete, binding-safe, and recoverable.
- **Acceptance criteria:**
  - 一级 status 只显示 `scope / phase / required_skill / non-zero anomaly counters`
    （`replan / blocked / repair / recovery / human_required / finding / cleanup` 为 0 时隐藏）。
  - 二级 detail 按需返回 Stage / Slice / Task / Work 明细（owner、waiting verifier、
    blocked_by、latest Result/Finding ref、candidate/integration Git ref、cleanup pending）。
  - Project Stage Map 是 Git-tracked execution-owned planning artifact（`delivery/project-stage-map.md`），
    保存 `goal / depends_on / entry criteria / Authority refs`；它不是 MES fact/status，不缓存
    operational readiness，不承担 Stage composition / next-stage decision。
  - current `ready / blocked / executing / accepted` 等 Stage 实时状态由 MES/Git facts 表达；
    MES/status 只观察 operational facts，不生成 Stage composition / next-stage decision。
  - MES 不输出"建议下一步"；不复制 Skill 内容或 Authority 正文；不代替 Brain route/dispatch；
    不充当新的 Gate / Receipt 系统。
  - MES 写入只接受 Brain 路由决策、结构化 Result/Finding、Review verdict、Git 事实；
    Agent narrative、transport `sent`/`idle`/`done`、session/transcript 状态、checkbox 不写入 MES。
  - Brain/Host 只表达并授权 semantic event，不读取或提交完整旧 snapshot、不计算 retention set、不承担 `submitted ∪ retained` composition；Role Agent/Worker/Verifier 不直接写 MES。
  - 每个正常 operational transaction 默认保持既有 durable fact IDs；除 Contract 明确声明的非历史 projection 外，不因 caller 少提交 facts 而删除 unrelated history。
  - `verification_result_ref` 等 binding-critical identity 由 current durable relation 唯一解析，或由 transaction layer exact-validate；提交值不等于 canonical relation 时 atomic fail-closed / no-write。
  - schema-readable 但 relation-invalid 的 immutable facts 可长期保留和审计，却不能授权 current operational state；restart/recovery 后仍保持相同分类。
  - MES 定义与机械 `proofloop` CLI 分离；Runtime 必须提供 root-bound MES snapshot/seed、strict fact/binding validation、只读 `proofloop status [--detail]` / `proofloop status --json [--detail]` observation 与唯一 operational transaction seam；`MesSnapshotStore` 仅是内部 persistence primitive，不暴露为 Brain-facing full-snapshot API；status 不输出 route/next action/reasoning。
- **Status:** confirmed

### FR-004: Brain control plane（route / dispatch / recovery）

- **Description:** Brain 是唯一 cross-phase route / dispatch / recovery owner。
- **User story:** As a Brain, I want workflow-constrained routing, so that legal actions and
  transitions are decided by the workflow contract and current facts rather than hardcoded old
  routing or a forced per-turn loop.
- **Acceptance criteria:**
  - Brain 依据 durable facts、workflow state、events 和 guards 决定允许的 operational action
    （route / dispatch / recover）；workflow 只规定合法 action / transition，不规定模型的
    reasoning steps、tool 顺序、读取频率或 loop。
  - 不要求每个模型 turn 都重新执行完整 workflow；进入具体流程后连续工作，直到该流程出现
    completion / transition / blocker / invalidation 再重新路由。
  - Routing Boundary 仅在新用户工作或实质变更、当前 Flow 完成或迁移、blocker/invalidation、
    recovery 四类事件重新选择 Flow；普通 tool result、Task Result、ACK、continuation 和同一
    Flow 内部迭代由当前 Flow/Contract 继续处理。
  - OpenCode `.opencode/agents/brain.md` 与 Pi `.pi/brain-workflow.md` 各自承载完整 Brain routing workflow；Pi/OpenCode 各自加载对应 Host 文档，不建立第三份 workflow/controller。
  - correctness-sensitive 边界保留 fresh validation（作为 correctness guard，不是 reasoning loop）：new/recovery/fresh dispatch 按 workflow 完成 session → host session identity → 所选 Host 的 Subagent dispatch（Pi 读取 `.pi/agents/*.md + .pi/subagents.json`；OpenCode 读取 `.opencode/agents/*.md`）→ send；finding disposition 前验证 accepted Plan / tech-spec / code reality；integration 前验证 Git/current binding；recovery 时重读 durable facts；Plan/Git tuple 变化后重新验证 SPV basis（FR-005）。
  - Brain 不硬编码完整阶段流程，不消费 Runtime 推导的 Primary Next Action。
  - Brain 不写详细 Stage/Slice/Task 规划（那是 Planner 职责），不生成 detailed Repair/Replan；按 accepted Plan 选择当前 dependency-ready Task 并投影其 JIT input 属于 Execute（`proofloop-execute`）projection，不是 Planning，也不改变 Planning 的 WHAT/WHEN/BOUNDARY ownership。
  - Brain 消费 current Project Stage Map + durable facts 做 route / dispatch / recovery；
    不创建/修订 Project Stage Map，不做 Stage / Slice / Task decomposition。
  - Brain→Planner 只传 current target / binding / fact refs 与 mutation boundary；Planning method 只来自所选 Host Planner Agent 文档（Pi `.pi/agents/proofloop-plan.md` 或 OpenCode `.opencode/agents/proofloop-plan.md`），Brain 不提供第二套 Planning 方法。
  - verifier finding（SPV / CV / Stage Reviewer）一律先回 Brain；raw finding 只是 evidence，
    不是 Worker / Planner 指令。
  - Verifier 只能提交 `verifier_verdict`、finding evidence 与 `claimed_route_code`；最终 `finding_disposition` 由 Brain 在重读 Authority / Plan / scope / code reality 后独立产生。
  - Brain 只在 `finding_disposition: ACCEPTED` 时使用合法的 `accepted_route_code` 路由；证据不支持 verifier claim 时记录 `VERIFIER_OVERREACH`，不自动触发 repair、Replan 或 `HUMAN_REQUIRED`。
  - `HUMAN_REQUIRED` 只在 Brain 接纳真实用户决策缺口后形成局部 pause；仅阻塞真实 dependency descendants，独立 Slice/Task 继续运行，不能由 verifier 自行发出。
- **Status:** confirmed

### FR-005: Planning（Thin Plan + JIT Work Packet + SPV + Replan）

- **Description:** Planning 是唯一 Planning 方法 owner，拥有公共 Project Stage Map 与 current Stage Thin Plan；Planner procedure 直接位于所选 Host Planner Agent system prompt，`proofloop-plan` 只保留 dispatch identity / packet references；SPV 只读 falsify；Replan 按 impact 分类，不 blanket rollback。
- **User story:** As a Planner, I want a thin executable plan, so that execution stays
  grounded in Authority without duplicating it.
- **Acceptance criteria:**
  - Thin Plan 只保存 Stage/Slice/Task goals、dependencies、semantic scope、code anchors、verification refs、done/stop conditions、小粒度 tech-spec refs；不复制 Authority 正文，
    不承载 Receipt/Gate 或 mutable execution state。
  - Planning 拥有公共 Project Stage Map（FR-003）+ current Stage Thin Plan；每次 Stage
    Planning 先做 Map Check（active Map 缺失则创建、存在则 review/revise），再产出
    current Stage Plan；Planner/SPV 必须验证 relevant PRD intent 已由 current tech-spec 完整表达，缺失或矛盾时返回 `AUTHORITY_GAP`，不得把 PRD-only obligation 直接塞入 Plan。
  - Planning 定义 WHAT / WHEN / BOUNDARY；`codebase-design` 是条件加载的 composition
    capability（composition owner 仍是 Planner）；Execute / Worker 决定 HOW。
  - JIT Work Packet 是 derived execution input（不是 Authority），projection owner 是
    Execute（`proofloop-execute`）：Brain running `proofloop-execute` 读取完整 accepted Plan、选择当前
    dependency-ready Task 并只为该 Task 投影 JIT input；Worker 只接收当前 Task，future Task body 不提前披露；包含 stage/slice/task、
    accepted Plan ref、tech-spec refs、code anchors、allowed scope、dependency outputs、
    done criteria、stop conditions、required Skills、Git/worktree basis。
  - 每个 Task 必须自足：具备 local closure（goal / semantic scope / code anchors / done & stop）、verification closure（可独立复核的 verification refs 与 oracle）与 future-HOW independence（只凭 Slice goal + 共享 context + 当前 Task + 已接纳 predecessor outputs + bound Authority + code reality 即可正确实现并验证）；SPV 必须显式反证后者，不成立时返回结构性 `PLAN_GAP`。
  - Task 边界不得机械切碎自然 TDD 顺序（RED → implementation → GREEN 属同一个 Task 的 HOW），也不得把需要 future Task body 才能正确实现的 obligation 留在当前 Task。
  - Planner 对四项 invariant 负责：`USER_INTENT_COVERED`、`TECH_AUTHORITY_RESPECTED`、
    `CODE_REALITY_GROUNDED`、`WORKER_EXECUTABLE`（Task 级 local closure、verification closure 与 future-HOW independence 成立）。
  - SPV 是独立 falsifier：全量 structural closure + high-risk edge code-reality
    counterexample challenge；输出 `PLAN_READY | FINDINGS | BLOCKED`；不直接 Replan。
  - SPV 初审的对象始终是 pre-accept candidate Thin Plan；`NORMAL` 的 SPV Result 先作为 `PLANNING_VERIFICATION_RESULT` 绑定 candidate（`accepted_plan_ref: null`），仅 `PLAN_READY` 经 Brain 接纳后才产生 `PLAN_ACCEPTANCE` 和 accepted Plan binding。
  - Plan/Git tuple 发生变化（包括 SPV finding 修复或 Replan）时，必须完整重新读取并执行 fresh full SPV initial verification，不复用旧 verdict；是否新建 Agent/session 由 lifecycle trust 与 clean-room 条件单独决定。
  - Replan 采用 impact-based：`carry_forward / invalidated / new-changed`；`invalidated`
    不等于 Git rollback；已有代码保留为 current code reality。
  - 删除旧 Manifest materialization、Evidence skeleton、Receipt、Admission、digest
    currentness、`stage next`、Gate、stable-boundary helper 作为业务前置的语义。
- **Status:** confirmed

### FR-006: Execute（Vertical Slice Execution Lane）

- **Description:** Execute 以 Vertical Slice Execution Lane 为自治单元；CV 为 Slice-level；
  CV PASS ≠ INTEGRATED。
- **User story:** As a Worker, I want one Slice-scoped lifecycle, so that I can progress
  Task-by-Task without per-Task Runtime re-dispatch.
- **Acceptance criteria:**
  - 每 Slice：one Worker lifecycle、one isolated Git worktree、one logical Worker lane、Task graph、
    Slice-level CV、durable Task/Result facts。
  - Worker 在同一 Slice lane 内逐 Task 实现；每 Task 只 fresh-read 由 Execute 投影的当前 Task JIT input / tech-spec refs / code anchors / dependency outputs；Task Result 写入 MES operational record。
  - Worker Task Result 必须携带 Slice-lane `actionToken` 与每次提交的 `resultId`；Brain 校验后返回 closed `TASK_RESULT_ACK`（`ACCEPTED|REJECTED` × `CONTINUE|PAUSE`），只有被接纳的 predecessor Result 才能被 successor 消费。
  - `TASK_RESULT_ACK` 不得携带 `next_task_id`、`next_action` 或其他业务调度指令；`ACCEPTED + CONTINUE` 后由 Brain running `proofloop-execute` 按 accepted Plan 的稳定 task order 选择下一 dependency-ready Task 并把该 Task 的 JIT input 投影给同一 Worker，Worker 不自行选择 successor；ACK 丢失、Brain 重启、重复提交与 stale token 按幂等/恢复规则从 durable facts 重新验证。
  - 全部 Task 完成且 self-check 后只形成 `SLICE_CANDIDATE_READY`。
  - CV 不做 Task-level review；Slice candidate ready 后 fresh CV 读取 Slice Goal +
    tech-spec/acceptance + Thin Plan + real code/tests/diff + Git refs，输出
    `PASS | FINDINGS | BLOCKED`；Worker result 仅 supporting evidence。
  - CV PASS/result + candidate ref durable 后关闭 live Worker/CV，此时仅
    `CV_PASSED / READY_TO_INTEGRATE`；Integration 成功才是 `INTEGRATED`。
  - Integration conflict/composition failure → durable finding → Brain；仅纯机械且无语义
    选择的冲突可 bounded resolve。
  - Worktree cleanup：`INTEGRATED → CLEANUP_PENDING → CLEANED`；cleanup failure 不回退
    `INTEGRATED`。
  - 全部计划内 Slice integrated → `EXECUTION_READY_FOR_REVIEW`。
- **Status:** confirmed

### FR-007: Review（三轴 Stage Review）

- **Description:** 集成后的 Stage 由 fresh runtime Review Agent 执行三个 independent passes：
  Outcome → Composition → Authority；PASS 后绑定 snapshot 产生 `STAGE_ACCEPTED`。
- **User story:** As a Stage Reviewer, I want independent axes, so that one PASS cannot mask
  another axis finding.
- **Acceptance criteria:**
  - 每轴独立输出 `PASS | FINDINGS | BLOCKED` + evidence；no masking；不 generic quality score averaging。
  - Outcome：accepted Plan / Acceptance 是否在 integrated reality 中成立（含 counterexample/scenario）。
  - Composition：cross-slice user flow、producer→consumer、state/data、error/recovery、
    cross-slice seams、Stage-level risk。
  - Authority：Architecture / Contracts / Hard Parts / Forbidden Shortcuts 的 Stage/cross-slice
    consequence。
  - Reviewer read-only，finding → Brain；不自行 route repair/replan。
  - bounded repair 且 Goal/Authority/Plan partition/material scope 未变：same Reviewer
    fresh-read 新 snapshot + finding + repair diff 后 bounded recheck；Goal/Authority/
    Plan decomposition/material scope/reviewer trust 改变则 fresh full review。
  - 三轴全部 PASS 且绑定当前 integrated Stage snapshot → `STAGE_ACCEPTED` 写入 MES。
  - 删除 Stage Gate、Review admission Receipt、Manifest、Runtime finalize、project-review mode。
- **Status:** confirmed

### FR-008: PROJECT_READY

- **Description:** 当当前 Delivery cycle 的 all planned Stages = `STAGE_ACCEPTED`，MES 写入该 cycle 的 `PROJECT_READY` 并提醒 PM；terminal 按自身 planned set / delivery basis 保持历史有效。
- **User story:** As a PM, I want a project-ready signal, so that I know the automated pipeline
  is complete and I can do final acceptance myself.
- **Acceptance criteria:**
  - `PROJECT_READY` 是当前 Delivery cycle 的自动流水线终态；不 dispatch Project Reviewer，不复用 `stage-reviewer`
    的 project mode，不增加 Project Acceptance phase/Skill。
  - PM 未立即验收不把项目标记 `BLOCKED` 或 `HUMAN_REQUIRED`。
  - 旧 `project-review.md`、`execute-project-acceptance.md` 与 project scope 已退役。
  - 历史 `PROJECT_READY` 继续按自己的 planned Stage set 与 delivery/planning basis 验证；后续 accepted Stage 不使它失效。
  - 新的实质工作、scope 增量或产品 intent 变化必须重新进入 `Propose`，不得从历史 terminal 直接进入 Planning/Execute。
- **Status:** confirmed

<!-- proofloop:entity id="delivery-cycle" kind="goal" -->
### FR-015: 可重复 Delivery cycle
- **Description:** `PROJECT_READY` 只关闭当前 Delivery cycle 的 planned delivery set，不是仓库生命周期的永久终态；后续新的实质工作开启新的 cycle。
- **User story:** As a PM, I want later substantive work to start a fresh delivery cycle, so that historical readiness remains trustworthy while new work follows the same controls.
- **Acceptance criteria:**
  - 当当前 cycle 的 planned Stages 全部 accepted 时，系统为该 cycle 产生 `PROJECT_READY`，并保留其 planned set 与 delivery/planning basis。
  - 当历史 `PROJECT_READY` 之后出现新的实质工作、scope 增量或产品 intent 变化时，Brain 先进入 `Propose`，不得直接进入 Planning 或 Execute。
  - 新 cycle 继续使用 Propose → Planning → Execute → Review → `PROJECT_READY`，并可产生独立的 current terminal。
  - 历史 terminal 按自身 planned set / basis 保持 durable validity；后续 cycle 的 Stage 或 terminal 不改写其含义。
  - PM 只在当前 cycle 的 `PROJECT_READY` 收到 ready 提醒；不增加 Project Reviewer、Project Gate 或额外 Acceptance phase。
  - `status` 只读观察 current operational cycle；尚未开始新 cycle 时可显示历史 ready detail，但不从历史 terminal 推导 route。
- **Status:** confirmed

<!-- proofloop:entity id="authority-gap-and-continuation" kind="goal" -->
### FR-016: Authority handoff and unattended continuation
- **Description:** 当产品意图不变但 Technical Authority 缺失、矛盾或被当前可验证现实反证时，系统必须回到正确的 Authority owner 收口；系统不能因为用户暂时离线而停止合法 Flow。
- **User story:** As a PM, I want ordinary Authority repair and valid delivery work to continue without my presence, while real product decisions still pause the affected work.
- **Acceptance criteria:**
  - Planning/SPV 发现 PRD→tech-spec handoff 缺口或 grounded Technical Authority invalidation 时，形成 `AUTHORITY_GAP` 并回到 Propose owner；不把实现选择、技术未知或 Runtime 缺陷伪装成 Authority gap。
  - authorized/current Authority owner完成 bounded update后，Brain fresh-read并接纳 canonical package，再经`authority-update`边界继续`PROPOSE_READY`与fresh Planning；普通 Technical Authority repair不要求额外用户审批。
  - 用户在线状态、是否继续发送消息、Agent/session/transcript transport 状态都不是 Propose、Planning、Execute、Review continuation 的产品前置条件。
  - 只有真实产品、权限或验收决策缺口，经 Brain 确认 `USER_DECISION_REQUIRED` 后，才形成局部 `HUMAN_REQUIRED`。
- **Status:** confirmed

<!-- proofloop:entity id="current-terminal-status" kind="goal" -->
### FR-017: Current delivery terminal status
- **Description:** 当 current delivery cycle 已有合法 `PROJECT_READY` 时，公开 status 必须让用户和机器看到 current ready truth，同时保留历史 terminal 与 pre-terminal 场景的区别。
- **User story:** As a PM or Brain, I want status to show the current delivery result, so that a stale Stage label cannot hide a completed cycle.
- **Acceptance criteria:**
  - current legal `PROJECT_READY` 在 human、`--json` 与 `--detail` status 中可观察。
  - historical-only、current terminal、pre-terminal 与 duplicate/conflicting/跨 cycle terminal 场景可区分；歧义 fail closed。
  - status 只读，不输出 route/next action/reasoning，不增加第二 status store、controller、Gate 或 lifecycle。
- **Status:** confirmed

<!-- proofloop:entity id="mes-operational-ownership" kind="goal" -->
### FR-018: MES durable operational ownership 与冻结恢复安全
- **Description:** ProofLoop 接受一个 operational event 后，必须由唯一 MES operational transaction layer 安全维护 durable execution state；Brain/Host 只表达并授权 semantic decision，不维护完整 snapshot。已存在的 relation-invalid facts 必须可长期审计但不能授权 current execution；当 NORMAL MES 被 integrity incident 冻结时，系统必须提供不依赖 unsafe NORMAL writer 的合法 maintenance/recovery seam，完成整改并重新审计后才能通过受影响 Stage/cycle 的 `resume` / `replan` / `restart` 决策恢复 NORMAL execution。
- **User story:** As a Brain and maintainer, I want accepted operational events and recovery actions to be durable, relation-safe, and replayable, so that an incident cannot silently erase history or authorize work under a wrong binding.
- **Acceptance criteria:**
  - 正常 semantic event 不要求 caller 读取、提交或组装完整旧 snapshot；与本事件无关的 durable fact identities 保持存在。
  - `verification_result_ref` 等 binding-critical identity 能由 current accepted relation 唯一解析，或由 MES exact-validate；任何 typo、旧 ref、近似 ref 或歧义 relation 都 atomic fail-closed / no-write。
  - 已存在的 schema-readable、immutable、relation-invalid facts 保持 readable/auditable，但不授权 Task/Slice completion、Integration/CLEANED、`STAGE_ACCEPTED`、`PROJECT_READY` 或受影响 Stage 的 continuation；restart/recovery 后分类不变。
  - 当 MES integrity hard-freeze 成立时，停止受影响 Stage 的 NORMAL Execute/Review 与 MES NORMAL operational writes；public status 仍只是 observation，不能授权 dispatch。
  - MES Runtime 修复可通过 canonical Authority、exact Git、forensic/audit 与 frozen snapshot basis 建立独立 maintenance/recovery seam；不得 revival `PRE_MES_BOOTSTRAP`、制造 fake facts 或建立第二 MES。
  - 解除冻结前完成 exact incident regressions、fresh rehydrate、relational audit 与 impact-based S06 `resume` / `replan` / `restart` 决策。
- **Status:** confirmed

### FR-009: Recovery

- **Description:** Agent、session 或 session 丢失后，从 durable facts 恢复，不恢复隐藏会话。
- **User story:** As a Brain, I want rehydration from real facts, so that interrupted work
  resumes without duplication or invention.
- **Acceptance criteria:**
  - 恢复输入按事实类别绑定：Planner/SPV 使用 MES durable state + candidate Plan + Authority + planning verification Results/Findings + Git/worktree reality；Execute/Worker/CV/Review 使用 MES durable state + accepted Plan + Authority + structured Results/Findings + Git/worktree reality。
    `PRE_MES_BOOTSTRAP` 仅使用 Git-tracked Plan + canonical Authority + structured Subagent transport evidence + Git/worktree reality。
  - Brain/Host 恢复时按 lifecycle Contract 重建受影响 durable facts 与 binding，再加载对应 Flow；
    status 只作 observation，不能代替 recovery basis 或产生 next action。
  - 不恢复旧 Primary Next Action / credential 链；不恢复 hidden conversation / session。
  - 并行 Slice 一个 blocked 不阻断无依赖 Slice。
  - ACK 丢失或 Brain 重启时，已 durable 接纳的 Task Result 只重发等价 ACK，不重复写完成事实；未接纳 Result 可用同一 `resultId` 重放，binding 改变则旧 `actionToken` 失效并进入 recovery/fresh。
  - 人类决策返回后，Brain 先让 canonical owner 吸收输入，再按 Authority、accepted Plan、goal/acceptance 或 proof boundary 是否改变选择 impact-based Replan；仅解除 operational blocker 时直接重算依赖并恢复。
- **Status:** confirmed

### FR-010: Subagent host lifecycle 与 Subagent dispatch
- **Description:** Subagent host/Subagent host adapter 承担 Agent runtime/lifecycle/transport；dispatch 从所选 Host 的 versioned 配置读取 launch configuration：Pi 使用 `.pi/agents/<subagent_type>.md + .pi/subagents.json`，OpenCode 使用 `.opencode/agents/<subagent_type>.md`。这些文件是 versioned Host adapter subagent-dispatch config：它们不是 Git-tracked project truth，不是 MES / Plan / SPV / CV / Review currentness 输入，一次干净 repository checkout 必须包含启用 Host 的对应配置，其存在与合法性只在该 Host dispatch 时按既有 typed 语义判定。ProofLoop 只规定 `role_skill == subagent_type` 与 session/transport transaction，不复制任一 Host adapter schema、runtime/model 参数或 variant 选择逻辑；lifecycle 由 `.agents/contracts/brain/agent-lifecycle.md` 定义。
- **User story:** As a maintainer, I want host/runtime choices separate from process authority,
  so that changing a model never changes role behavior.
- **Acceptance criteria:**
  - NEW/FRESH/RECOVERY-new-agent dispatch 固定执行：选择 `role_skill` → `subagent_type := role_skill` → 由所选 Host 创建 Role instance → Subagent host dispatch → 发送最小 packet → Host native result retrieval（Pi `get_subagent_result`；OpenCode child dispatch returned result/failure 或 completion notification）；normal dispatch 不依赖 peer registry。
  - 所选 Host 的 dispatch config 与 role/dispatch skills 一一对应：Pi 为 `.pi/agents/*.md + .pi/subagents.json`，OpenCode 为 `.opencode/agents/*.md`；不新增 Role→Pool/Profile/config 映射表、alias 或 compatibility layer。
  - Host dispatch config 是 versioned Host adapter config：Pi 使用 `.pi/agents/*.md + .pi/subagents.json`，OpenCode 使用 `.opencode/agents/*.md`；由 Git 跟踪，不依赖 ignore；本地 Host 配置修改不构成业务事实；业务 boundary 必须与 Host 配置变更分离；缺失所选 Host 的版本化配置即为配置阻塞。两个 Host 可有不同的 native schema，但不得产生第二份业务 workflow/Result/Authority source。
  - live Subagent host Subagent type/session 是唯一 ephemeral instance address，不要求与 `subagent_type` 相等；Subagent type、agent_id、session_id、transcript 与 transport message id 不进入 MES、Result 或业务 Authority。
  - Role lifecycle：`general`/`researcher` one-shot；`prototype`/`worker` continuation；`stage-plan-verifier`/`code-verifier`/`stage-reviewer` review-loop；Planning 使用 `proofloop-plan`。
  - Subagent host adapter 负责配置 schema、variant 选择与 runtime/model 参数；ProofLoop workflow/Skill 不重新实现这些语义。启动失败返回 typed `RUNTIME_BLOCKER`，不 fallback/retry。
  - 缺失或非法 config 仍 fail closed 为既有 typed `RUNTIME_BLOCKER`；不新增 fallback、retry、quota detection、自动 model routing、Profile/Pool/alias/mapping layer 或第二份业务 workflow/Result/Authority source。

### FR-011: Mechanical primitives 保留

- **Description:** 与旧业务模型无关的机械安全能力抽取复用，不随旧控制链删除。
- **User story:** As a maintainer, I want safety primitives preserved, so that deleting legacy
  business control does not delete path/Git/process safety.
- **Acceptance criteria:**
  - 保留：canonical project root、root-bound path、component-wise symlink escape protection、
    `openNoFollowRead`/TOCTOU-safe read、stable relative-path validation。
  - 保留：process runner 的 `shell:false`、shell/operator prohibition、bounded output、
    timeout/cancellation、process-tree cleanup、service readiness/teardown。
  - 保留：Git root/HEAD/status/diff 读取、dirty/untracked 检测、exact allowed-path staging
    boundary、worktree create/remove、candidate/integration ref、protected `.git`/internal
    path 约束、commit/integration 前后机械一致性检查；删除 Gate/Review/Receipt/Manifest
    business preconditions。
  - 保留：protected-path 概念（不允许 Agent/Work 改内部控制文件、越界文件、其它 Slice
    未授权路径），输入改为 Work Packet allowed scope + MES work identity + canonical
    protected roots。
  - 保留：ID/schema shape 校验（closed enum、bounded JSON shape、canonical-root-safe ref）。
  - 保留：replan impact classifier 核心（task-local / slice-wide / stage-wide / unresolved）
    与 dependency closure / carry_forward / invalidated 推导，输入改为 accepted Plan +
    current code/MES facts。
- **Status:** confirmed

### FR-012: Legacy 语义退役

- **Description:** 旧业务控制模型整体删除，不建立 compatibility layer，也不为"已经写过"
  保留 Receipt/Gate/Manifest credential 语义。
- **User story:** As a maintainer, I want one active flow, so that no second authority can
  decide what is allowed.
- **Acceptance criteria:**
  - Admission / admit-* pipeline、Receipt category/chain/digest currentness、Receipt admission
    （Worker/CV/SPV/Integration/Review/Stage Close）、`.proofloop/receipts/**` 作为 correctness
    authority、reconcile/reducer/stage-state 中由 Receipt 推导业务状态的模型 —— 全部退役。
  - Manifest compiler/source/route、Manifest digest currentness、Manifest-declared Evidence
    skeleton/refresh/rotation、Manifest 与 Receipt/Context/Gate binding chain —— 全部退役
    （普通测试结果 / Reviewer evidence / RED-GREEN Evidence 等证据数据不在删除范围）。
  - `.proofloop/context` credential/projection 体系、`proofloop context prepare/show`、
    CV refutation observation Context gate、Context digest currentness —— 全部退役。
  - `proofloop stage next`、derive-next-action / next-action-service / vNext next route table、
    Runtime 根据 Receipt/Manifest/Context 推导唯一下一业务动作的职责 —— 全部退役。
  - Stage Gate（run/status）、Gate Receipt、Stage Review admission/finalize Receipt、
    Stage Close Receipt/archive credential、Gate/Review Receipt 作为 Git close 业务前置 ——
    全部退役；Git 操作仍做机械安全校验，不再要求 Gate/Receipt credential。
  - project acceptance（project-review.md、execute-project-acceptance.md、acceptance manifest /
    E2E receipt / finalize-project-review / project mode）—— 退役。
  - binding-currentness（Manifest/Receipt/Context digest 当前性）、legacy recovery domain、
    cutover compatibility scan、v1/vNext dual-route —— 退役。
- 旧 CLI 中所有 legacy business-control domain 必须从 CLI 移除；public CLI 保留机械 Git boundary adapter（`boundary close`）、dedicated Integration adapter（`integration apply`）与只读 MES status observation（`status [--detail]` / `status --json [--detail]`），不把这些 Runtime seams 扩写为完整 Brain/MES 流程。
- **Status:** confirmed

### FR-013: Slice 级证明绑定（2026-08-15 整改需求；按新流程语义重写）

- **Description:** 把执行证明的绑定单位从"整个 Stage 计划/清单"改为三层：Stage 全局契约、
  每个 Slice 自己的契约、执行时的绑定（accepted Thin Plan + MES work identity + Git basis）。
  Slice 内 Replan 按影响范围分级：Task-local 变更只影响当前 Task 及其后续 Tasks；
  影响此前成果时升级为 Slice-wide Replan。一个 Slice 的计划调整只让该 Slice 及其依赖者
  失效，已完成且未受影响的 Slice 证明保持有效。
- **User story:** 作为把 ProofLoop 流程迁移到其他项目使用的开发者，我希望一个 Slice 的返工
  不需要让整个 Stage 从头再来，这样项目越大越不会被一次小调整拖垮。
- **Acceptance criteria:**
  - Case 1（只改 C）：当 A/B 已集成完成、只修改 Slice C 的 Thin Plan 时，A/B 的完成证明
    保持有效，仅 C 失效重跑。
  - Case 2（依赖链）：当 A→C→D 依赖链中 A 改变时，A/C/D 失效，无关的 sibling（B）保持有效。
  - Case 3（全局契约）：当 Stage 全局契约改变时，所有 Slice 证明失效（全部重来是正确行为）。
  - Case 4（仅运行证明）：当只改运行/验证安排、Slice 契约未变时，Slice 证明保持有效，
    仅对应验证重跑，不重跑无关 Worker/CV。
  - Case 5（权威引用）：当只有 A 引用的 Authority 内容改变时，仅 A 失效，不引用它的 B 不变。
  - Case 6（回归）：当使用旧模式（无三层绑定）的 Stage 时，行为与旧流程一致
    （fail-closed 不变）。
  - Case 7（红线）：禁止：为并行虚报允许修改范围、每个工作区各持一份凭证、CV 通过后自动
    rebase、AI 直接修合并冲突保留旧结论、Worker 继续改共享状态文件、用进度快照判断完成、
    保存会话 id 用于恢复权威、一个 Slice 改变就整个 Stage 重跑。
  - Case 8（Task-local Replan）：当变更只影响当前 Task 及其后续 Tasks，之前已由 MES 记录
    `TASK_COMPLETE` 且边界未变的 Task 成果保持有效，即使 Slice 尚未完成 CV/Integration；
    当前 Task 与受影响的后续 Task 重新规划/执行。
  - Case 9（Slice-wide Replan）：当变更影响之前已完成 Task 的目标、验收含义、证明边界、
    Task 依赖或执行范围，整个 Slice 的相关成果失效并重新规划/执行；不得静默沿用受影响结果。
- **Binding model:** 三层 fingerprinting 基于 accepted Thin Plan + MES work identity +
  Git basis 表达，不退回旧 Manifest/Receipt credential 链；replan impact 分类复用
  机械 replan-impact 算法核心。
- **Status:** confirmed

### FR-014: Evidence 与 Result 纪律

- **Description:** structured Result/Finding 与证据是 MES 的写入依据；Agent narrative 不是。
- **User story:** As a Brain, I want evidence-bound results, so that completion never relies
  on summaries.
- **Acceptance criteria:**
  - Task Result 写入 MES 必须携带可重读绑定（stage/slice/task、accepted Plan ref、
    Git basis、Result/Finding ref）。
  - `subagent` message id、send status、session/transcript 状态、`sent`/`idle`/`done`、
    模型摘要、checkbox 不构成流程完成依据。
  - RED/GREEN 改称 RED/GREEN Evidence，不重新引入 Receipt credential 语义。
  - `AUTHORITY_GAP` 仅由 Planning/SPV 在 relevant Product intent → current Technical Authority → grounded current reality 的闭合中正式分类：包括 PRD obligation 在 tech-spec 缺失/矛盾，或 Product intent 不变但 bounded code/runtime reality 证明 current tech-spec 已不成立/不足且继续规划必须更新 canonical Technical Authority；实现选择错误走 `PLAN_GAP`，技术可行性未证走 `TECHNICAL_UNKNOWN`，实现缺陷走 normal repair/planning。Execute/CV/Review/General 不直接 claim `AUTHORITY_GAP`。
- **Status:** confirmed
- **MES ownership / binding safety:** Brain/Host 只发起并授权 semantic event；MES transaction layer 负责 materialize durable fact 与 relation。可由 current durable relation 唯一解析的 `verification_result_ref` 等 identity 不由 caller 手工拼接；submitted binding 与 canonical relation 不一致时 no-write。

## 9. Product-level constraints that affect implementation

| Area | Requirement | Status | Simple explanation |
|---|---|---|---|
| Login / account | 不需要 ProofLoop 账户 | confirmed | 本地流程；不引入账户体系 |
| Data saving | MES operational facts 必须可重建 | confirmed | durable write、restart 后可恢复、status projection；存储技术实现时选择 |
| Roles / permissions | 按角色隔离能力 | confirmed | Pi/OpenCode 对应 Host Agent 文档定义角色职责；Brain 文档拥有 route/dispatch owner |
| Uploads | 不需要 | confirmed | 不增加上传能力 |
| Import / export | 不需要新增 | confirmed | 迁移按 MIGRATION.md 复制改写 |
| Mobile use | 不适用 | confirmed | 本地开发 Agent 环境 |
| Privacy / security | Host metadata 不得成为业务 authority | confirmed | Subagent type/session/session/transcript/message id 只作 ephemeral |
| CLI surface | public CLI 提供 `boundary close`、`integration apply` 与只读 MES `status`（`--detail` / `--json`）；更广泛 operational command 不在本版范围内 | confirmed | CLI 只承载机械事务与最小 observation，不扩展为业务 Router |

## 10. Scope for this version

### Must have

- 四阶段生命周期 Propose → Planning → Execute → Review → PROJECT_READY。
- Product Authority（PRD）与 Technical Authority Pack（Architecture / Contracts / Acceptance），`PLAN_READY` 后 downstream tech-spec-only。
- MES + status（最小默认暴露；sparse anomaly counters；二级 detail）。
- Brain workflow-constrained route / dispatch / recovery（status 是 observation input，不是每轮强制第一步）。
- Thin Plan + JIT Work Packet + SPV（PLAN_READY）+ impact-based Replan。
- Vertical Slice Execution Lane（one Slice = one Worker + one worktree + one tab；
  Slice-level CV；CV PASS ≠ INTEGRATED；cleanup）。
- 三轴 Stage Review（Outcome / Composition / Authority）+ STAGE_ACCEPTED。
- PROJECT_READY（不设 Project Reviewer/Gate）。
- 可重复 Delivery cycle：`PROJECT_READY` 按当前 planned set 关闭 cycle；历史 terminal 与后续 cycle 可按各自 basis 重建；新实质工作从 Propose 开始。
- `AUTHORITY_GAP` 的 expanded handoff/invalidation route、`authority-update` acceptance 与 user-presence continuation。
- current delivery terminal 的 read-only public status truth（human / JSON / detail）。
- Slice-level proof binding（三层 fingerprinting；Task-local / Slice-wide Replan）。
- Recovery（MES + Git + structured Result/Finding rehydrate）。
- Subagent host lifecycle + Subagent dispatch through current workspace versioned Host adapter: Pi `.pi/agents/*.md + .pi/subagents.json` or OpenCode `.opencode/agents/*.md` (`role_skill == subagent_type`; lifecycle Contract）。
- Mechanical primitives 抽取复用（path / process / Git-worktree / protected-scope /
  ID-schema / replan-impact）。
- MES operational transaction ownership：semantic event → current-state materialization → relation/binding validation → preserve unrelated history → atomic persistence；normal caller 不维护 full snapshot。
- Frozen MES maintenance/recovery seam、immutable invalid-history isolation 与 exact binding/no-write safety。
- Legacy business-control 语义退役（Admission / Receipt / Manifest credential /
  Context Gate / stage next / Stage Gate / project acceptance / legacy currentness-recovery）。

### Can be simplified

- MES 的 persistence seam 采用 root-bound JSON snapshot + seed record；normal semantic transaction、完整 durable write-back、binding/关系校验与 recovery safety 是本产品边界的 must-have 语义，具体模块/API 由 Technical Authority 与后续 Planning 决定。
- `proofloop status` CLI 提供最小只读 projection（一级摘要与 `--detail` / `--json`）；更丰富的 operational detail/aggregation 仍可按后续任务分步实现，但不得改变 MES transaction ownership 或把 status 变成 route/mutation authority。
- 首轮只验证 Linux 环境。

### Explicitly out of scope

- 修改 `subagent/1` envelope 或增加 ProofLoop 专属字段。
- 新建 ProofLoop Launcher、Agent Manager、Registry、Session DB、queue、scheduler、
  retry daemon 或图形化 Dashboard。
- 自动 quota detection、provider/model fallback、自动 retry、价格/负载路由或自动 Subagent host variant migration。
- 为旧 Receipt Chain 建 compatibility layer。
- 把 MES 扩展为业务解释器、Router 或第二套 Runtime。
- 不新增并发执行器/调度器、并行 worktree 基础设施或新的 Git 提交流程；
  但 MES 状态模型必须支持多 Slice lane 的并行状态/依赖隔离（一个 blocked 不阻断无依赖 Slice）。
- Project-level 自动总体验收。

### Later versions

- 更多非 Pi/OpenCode runtime 的 Subagent host adapter variants。
- 更丰富的宿主诊断和可视化生命周期工具（不引入第二套流程 authority）。
- Windows/macOS 的完整实机验收。

## 11. Stage 规划起点（当前规则）

PRD 默认不生成 execution Stage candidates。Project Stage Map 与 Stage/Slice/Task 的分解
是 Planning 阶段（`proofloop-plan`）的职责；只有产品明确规定交付顺序时，才在 PRD 中记录
Product Delivery Constraint 供 Planning 参考。本版无产品规定的交付顺序约束。

active Project Stage Map 缺失时，首次 Planning 负责创建公共 Map（FR-005 Map Check）；
Map 存在时，后续 Planning 对 current/future Stage 做 rolling-wave review/revise。PRD
不记录 implementation progress，也不缓存 Stage 实时状态（实时状态由 MES/Git facts 表达，FR-003）。

## 12. Risks and edge cases

- **MES 重新变成 state machine：** MES 开始输出 next action、判断 Repair/Replan 或复制
  Skill workflow 时，必须回退；MES 只保存 operational facts / status，Brain + Skill 做 reasoning。
- **旧 Receipt/Gate 与新 MES 双权威：** 每个业务域只有一个 cutover 点；新路径切换后立即
  删除旧调用；旧 API 不作为 fallback。
- **Skill 继续携带旧 Gate 语义：** active Skill 禁止业务意义上的 Receipt / Admission /
  Manifest credential / Context Gate / stage next / Gate PASS / finalize credential；
  通过 lint/search checklist 控制。
- **Brain context drift：** correctness-sensitive 决策（new/recovery/fresh dispatch、finding
  disposition、integration、recovery、Plan/Git tuple 变化）前必须基于当前事实验证，不能依赖
  "Brain 应该记得之前读过"；连续常规工作不强制每轮全量 reread。
- **Verifier 被 operational state 污染：** verifier packet 给 target/basis/evidence；
  MES status 只作为最小阶段/Skill 提醒，不作为 PASS/FINDING 证据。
- **删除旧代码时误删安全能力：** 先抽取 path guard / no-follow / Git dirty-allowed-path /
  process safety / protected scope / ID validation / replan impact，再删除 business wrapper。
- **局部返工连坐：** 缺少三层绑定时，一个 Slice 的计划调整使无关 Slice 证明失效；
  由 FR-013（Case 1-9）约束。
- **PM 验收缺失：** `PROJECT_READY` 后 PM 未立即验收不标记 BLOCKED/HUMAN_REQUIRED。
- **历史 terminal 被误当作永久终态：** `PROJECT_READY` 必须绑定自身 planned set / delivery basis；收到新实质工作时只把历史 terminal 作为 durable history，并从 Propose 建立 current cycle。
- **Authority repair误分类：** grounded Technical Authority invalidation若被当作`PLAN_GAP`或实现缺陷，会让后续规划继续消费失效规范；由 Planning/SPV 的 expanded `AUTHORITY_GAP`与 Brain acceptance/`authority-update`闭合。
- **用户离线误阻塞：** 不应把用户未发送消息当作`HUMAN_REQUIRED`；只有真实产品/权限/验收决策缺口才局部暂停。
- **current status陈旧：** public status若只显示per-Stage label而忽略合法current `PROJECT_READY`，必须复用既有terminal/current-cycle facts修复，不新增第二状态源。
- **MES partial replacement / binding mismatch：** store 若把 semantic delta 当 full snapshot，或 caller 手工拼接 binding-critical ref，可能删除 unrelated facts 或产生永久 misbound facts；由 MES transaction layer 的 preserve-by-default、canonical binding 与 atomic no-write 约束。
- **错误 immutable history 被重新授权：** bad fact 不能靠 correction fact、newest-wins、插入顺序或 silent backfill 恢复 currentness；必须保留且 deterministic non-authorizing。
- **修复 writer 的循环依赖：** NORMAL MES 被 hard-freeze 时，不能用同一 unsafe writer recovery；必须先经 Authority/Planning/SPV 闭合独立 maintenance/recovery seam。

## Rollout / Migration

1. 新 MES/status + 新 Skill/Brain flow 可独立运行。
2. path / process / Git / protected-scope / replan-impact 机械 primitive 接到新流程。
3. 新 Planning/Execute/Review E2E 不再调用任何 legacy business-control API。
4. 删除旧 public domains 与 Brain/Skill references。
5. 删除 Admission/Receipt/Manifest/Context/Gate/currentness/recovery/project-acceptance
   实现与测试。
6. 删除 cutover/dual-route compatibility code。
7. 全仓扫描 stale names / docs / fixtures / examples（历史段显式标记 legacy）。

迁移过程中不自动迁移旧 Agent session、旧 dialogue 或旧 Runtime-owned 制品。

## Legal / Privacy / Security

- 不新增账户、支付或敏感业务数据处理。
- Host Role documents、Subagent host config 与 Host metadata 不得包含密钥、凭据或个人隐私数据。
- Subagent host/Subagent transport 失败时必须保留权限边界和 fail-closed 行为。
- MES、Result、Finding 和 Git facts 不可由 Agent 或 dialogue 直接伪造。

## 13. Glossary

| Term | Simple explanation |
|---|---|
| Propose | 建立 canonical Authority 的阶段；最终一次 `PROPOSE_READY` |
| Planning | 自动规划阶段：Thin Plan + JIT Work Packet + SPV |
| Execute | 自动执行阶段：Vertical Slice Execution Lane + Worker + CV + Integration |
| Review | 自动评审阶段：三轴 Stage Review + `STAGE_ACCEPTED` |
| `PROJECT_READY` | 当前 Delivery cycle 的 planned Stages 全部 accepted 后的自动流水线终态；按自身 basis 保留为历史事实 |
| Delivery cycle | 从 Propose 开始、以该 cycle 的 `PROJECT_READY` 结束的一轮 planned delivery；后续实质工作开启下一轮 |
| MES | 内部执行管理层：operational facts / record / traceability |
| status | MES 的最小默认暴露面：scope / phase / required_skill / 非零异常计数 |
| Thin Plan | 只保存执行所需 facts 的 Stage/Slice/Task 计划，不复制 Authority 正文 |
| MES operational transaction layer | 接收 Brain 的 semantic event，并读取、物化、校验、持久化完整 durable state 的唯一正常写入层 |
| binding-critical identity | 决定 fact 属于哪个 accepted Plan/cycle/relation 的关键标识 |
| maintenance/recovery seam | NORMAL MES 冻结时可在独立授权下实现或验证 Runtime 修复的入口 |
| non-authorizing history | 可保留和审计、但不能授权 current operational state 的 immutable 历史事实 |
| JIT Work Packet | Task 开始时生成的 derived execution input |
| Slice lane | 一个 Slice 的自治执行单元（Worker + worktree + tab + CV） |
| CV | Slice-level 只读独立反驳验证 |
| SPV | 对候选 Thin Plan 的只读独立 falsification |
| Stage Reviewer | 集成后 Stage 的三轴只读评审 |
| `AUTHORITY_GAP` | Planning/SPV确认 Technical Authority缺失、矛盾或被 grounded current reality 反证，必须由 canonical Authority owner 修正 | confirmed | 不等同于实现缺陷或技术未知 |
| `authority-update` | Brain 接纳 authorized/current Authority owner 的 bounded update 后，经机械 Git boundary 固化 | confirmed | 普通 Authority repair不要求用户再次审批 |
| `USER_DECISION_REQUIRED` | 需要真实产品、权限或验收取舍的缺口 | confirmed | 仅经 Brain 确认后进入局部 `HUMAN_REQUIRED` |
| Historical/legacy | 已退役的旧流程语义；文档中仅作历史说明，不形成 route |

## 14. Decision ledger

### Confirmed

- 四阶段生命周期 Propose → Planning → Execute → Review → PROJECT_READY。
- Product Authority 与 Technical Authority Pack 按 phase 分层；`PLAN_READY` / `PLAN_ACCEPTANCE` 后 tech-spec Pack 是 downstream normative truth，accepted Plan 是 execution instruction。
- MES 是 operational facts 来源；status 是最小默认暴露面；MES 不做 reasoning。
- `AUTHORITY_GAP` 的正式 owner 是 Planning/SPV；Brain 将其路由到当前 Propose Authority owner。authorized/current Authority owner 完成 bounded update 后由 Brain acceptance 与 `authority-update` mechanical boundary 接纳；普通 Technical Authority repair不构成额外用户审批 checkpoint。
- Brain 是唯一 cross-phase route / dispatch / recovery owner。
- Host Role Agent system prompt 决定对应 role procedure（Planning 使用 `.pi/.opencode` Planner 文档，Execute 使用 `proofloop-execute` phase capability projection）；Capability Skill 只提供可复用技术方法，不作为 Role workflow owner；不新增 `proofloop-propose`、`planner` Skill、`proofloop-review`。
- 旧 Admission / Receipt / Manifest credential / Context Gate / `stage next` /
  Stage Gate / legacy currentness-recovery / project acceptance 全部退役；
  机械安全原语抽取复用。
- Slice-level proof binding：三层 fingerprinting（Stage 全局契约 + per-Slice 契约 +
  执行绑定），按 Thin Plan + MES + Git basis 表达；Task-local / Slice-wide Replan 分类。
- one Slice = one Worker lifecycle + one worktree + one tab；CV Slice-level；
  CV PASS ≠ INTEGRATED。
- verifier finding 一律先回 Brain；raw finding 不是 producer instruction。
- all Stage accepted → `PROJECT_READY`；PM 自行最终验收；无 Project Reviewer/Gate。
- `PROJECT_READY` 只关闭当前 Delivery cycle；历史 terminal 按自身 planned set / delivery basis 保持有效，新实质工作必须从 Propose 开始下一 cycle。
- 不再维护独立的 review capability；Stage Reviewer Host Agent 按需加载 `security-and-hardening`。
- public CLI 保留机械 Git boundary adapter（`boundary close`）、dedicated Integration adapter（`integration apply`）与只读 MES status observation（`status [--detail]` / `status --json [--detail]`）；更广泛 operational command 不在本版 Runtime seam。
- MES integrity hard-freeze 是成立期间的 operational safety constraint：在 MES remediation / legal recovery 前禁止受影响 Stage 的 NORMAL Execute/Review/MES writes；不能通过 status projection 或修改被冻结的 Plan/Map 绕过。S06 是该机制已发生并已合法闭合的实例，不表示当前仍处于 hard-freeze。 — source: S06 incident 与本次 Propose
- 已知 relation-invalid immutable facts 必须保留为 readable/auditable non-authorizing history；canonical binding mismatch atomic no-write；正常 semantic transaction 默认保持 unrelated durable fact IDs。 — source: 本次 MES integrity remediation Propose
- NORMAL MES 被冻结时，Runtime 修复必须通过不依赖 unsafe NORMAL writer 的 bounded maintenance/recovery seam；不 revival bootstrap、不建第二 store、不伪造事实。 — source: 本次 MES integrity remediation Propose

### Inferred

- MES 持久化技术（JSON / NDJSON / SQLite）实现时选择，不把 schema 变成新的 Product Authority。
- Planner packet/result schema、SPV/CV Result schema、Stage/Slice/Task 最终 machine schema
  在实现时确定。
- AI-owned assumption（不改变 phase-scoped Authority model、低风险可逆且有验证路径）可带入自动阶段。

### Decided During Intake

- 本 PRD / Context / Tech Spec / 流程文档覆盖旧文档内容，不追加旧历史内容。 — source: 用户确认
- 旧流程语义整体退役，只保留机械原语。 — source: Wayfinder Map + 用户确认
- 不建立 compatibility layer。 — source: Wayfinder Map
- MES durable operational ownership：Brain/Host 只发起/授权 semantic event；唯一 MES operational transaction layer 负责 materialize durable facts、保留无关历史、binding/relation validation、幂等与 atomic persistence；`MesSnapshotStore` 仅为内部 primitive。 — source: 本次 MES integrity remediation Propose

### Open

- `proofloop status` 的最小参数与 projection 固定为 `status [--detail]` 与 `--json`；丰富 L2 operational aggregation 属于后续显式实现任务。
- MES 最小持久化采用 root-bound JSON snapshot + seed record；完整 operational fact write-back/storage 细节属于后续显式实现任务。
- Stage / Slice / Task 最终 machine schema（实现时确定）。

### Optional / Non-blocking

- 非 Linux 环境的完整实机验证。
- Subagent host adapter `.pi/agents/*.md + .pi/subagents.json` / `.opencode/agents/*.md` variants 的具体 model 由用户按额度调整。
