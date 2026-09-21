# Brain Workflow Contract

- 位置：`.agents/contracts/brain/workflow.md`
- 角色：ProofLoop Brain routing workflow 的唯一 canonical normative source
- 引用：Pi/OpenCode Host 与 Authority 文档按本路径引用；不复制本文流程正文

## 1. Brain identity and responsibility

Brain 是面向用户的 cross-phase orchestrator，也是唯一的 route、dispatch、recovery
和 finding arbitration owner。Brain 依据当前可重读事实和本 Contract 的 Routing
Boundary 选择 Flow；进入 Flow 后不接管该 Flow 的内部方法。

Brain 负责：

- 在 Routing Boundary 选择并派发当前 Flow；
- 在 Flow 完成或需要跨 Flow 迁移时选择下一个 Flow；
- 已有 Project Stage Map 时，联合 current Map 与 MES/Git facts 判断下一 Delivery Stage 的 route；需要 Stage composition judgment 时路由 `proofloop-plan`，不自行 planning；
- 对 blocker、invalidation 和 verifier/reviewer finding 做分类并选择恢复方向；对 `MES_MAINTENANCE` 只授权 bounded evidence-only execution/review，不授权任何 normal MES materialization。
- 在对应 Contract 允许时发起经授权的 semantic event；Brain 不组装或替换完整 MES snapshot；MES operational transaction layer 负责 durable fact/relation materialization、binding 校验与原子持久化。

MES/status 只保存并暴露 facts/observation，不生成 next action；MES operational transaction layer 是唯一 normal durable mutator，Role Skill 负责
角色方法；Git、Integration、launch/lifecycle 等事务的正确性由各自 owner 验证。
Workflow 约束允许的动作和迁移，不规定模型推理、tool 顺序或读取节奏。

## 2. Routing Boundary

Brain 只有在以下四类边界事件重新选择 Flow：

1. **新用户工作或实质变更**：需求、Authority、目标或范围需要建立或改变；该边界同样适用于历史 `PROJECT_READY` 之后的新 delivery cycle。
2. **当前 Flow 完成或迁移**：该 Flow 返回其完成信号，或明确要求进入下一个 Flow；
3. **blocker / invalidation**：当前绑定、范围、事务或验证基础失效，需要分类、修复或
   重新选择 Flow；
4. **recovery**：Agent、pane、session、Brain 或 transport 丢失，需从持久事实重建
   受影响绑定后选择继续、恢复或 fresh Flow。

普通 tool result、Task Result、`TASK_RESULT_ACK`、ACK、continuation、同一 Flow
内部迭代和暂时没有下一动作，不是新的 Routing Boundary；它们由当前 Flow 和其
Contract 继续处理。Agent `idle`/`done`、Link `sent`、checkbox 或模型摘要也不是
完成信号。

## 3. Trigger → Flow → Exit

| Trigger | Flow / owner entry | Exit / next boundary |
|---|---|---|
| 新产品范围、行为或验收需要建立/修改（含历史 `PROJECT_READY` 后的新实质工作 / 新 delivery cycle） | Propose：`ai-structured-prd`；按需 `prd-to-tech-design-prep`；`prd-to-ai-architecture` | `PROPOSE_READY` → 进入该 delivery cycle 的 Planning；post-ready 新实质工作不得绕过 Propose |
| `PROPOSE_READY`、上一 Delivery Stage 的 `STAGE_ACCEPTED` 或 Replan 请求 | Planning：`proofloop-plan`；SPV 使用独立的 `stage-plan-verifier` review-loop Role | fresh SPV `PLAN_READY` 被接纳 → Execute |
| accepted Plan 就绪且存在 dependency-ready Slice | Execute：`proofloop-execute` / Worker lane | Slice candidate → CV；全部 Slice `INTEGRATED` → Stage Review |
| recovery candidate + fresh SPV `PLAN_READY` + exact frozen/forensic/audit tuple + quarantine + Brain bounded authorization | `MES_MAINTENANCE` Execute/Worker lane | evidence-only Slice candidate → CV PASS → Git candidate/integration/cleanup evidence → maintenance Review；不写 MES、不进入 normal Stage/terminal acceptance |
| `SLICE_CANDIDATE_READY` | Slice-level `code-verifier` | `PASS` → Execute freeze-and-boundary 流程；`FINDINGS` / `BLOCKED` → Brain arbitration |
| CV `PASS` 且 candidate ref durable | Integration：`.agents/contracts/brain/integration.md` | `NORMAL` → `INTEGRATED`；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` → Git evidence integration；maintenance 完成后 → evidence-only maintenance Review，不写 MES |
| `EXECUTION_READY_FOR_REVIEW` | Stage Review：`stage-reviewer` | `STAGE_ACCEPTED` → 当前 Delivery cycle 的下一 Stage 进入 Planning（Brain 按 current Map + MES/Git facts route）或该 cycle 的 `PROJECT_READY` |
| verifier/reviewer finding 或事务 blocker | Brain arbitration / recovery | repair、Replan、Propose、Research/Prototype、HUMAN_REQUIRED 或 typed blocker |
| S06 MES integrity incident / hard-freeze | Brain recovery/integrity control; current public `status` remains observation only | physical MES quarantine → read-only forensic closure → current Propose/Technical Authority correction → fresh remediation Planning/SPV → `MES_MAINTENANCE` bounded evidence-only Worker/CV/Git/maintenance Review → controlled recovery → rehydrate/audit → S06 impact decision |
| Planning/SPV formal `AUTHORITY_GAP` | Propose：current authorized Authority owner / `ai-structured-prd` + `prd-to-ai-architecture` | bounded Authority update → Brain acceptance → `authority-update` → `PROPOSE_READY` → fresh Planning/SPV；普通 repair不新增用户 checkpoint |
| Agent/Host/Link/Brain loss 或 binding 失效 | Recovery | `RECOVER`、`REUSE`、`FRESH` 或 typed blocker |
| `MES_RECOVERY_REQUIRED`（exact MES pre-image unrecoverable） | Recovery/integrity branch：Brain 保持 blocker；current Technical Authority owner 先定义不依赖 NORMAL writer 的 `MES_MAINTENANCE` seam；Planner 只在 Authority closure 后产出 remediation/recovery candidate，fresh SPV 验证 | forensic/audit → candidate boundary → fresh SPV `PLAN_READY` → `MES_MAINTENANCE` bounded evidence-only Worker/CV/Git/Review → fresh exact-bound recovery candidate/SPV → one controlled transaction → immediate quarantine → rehydrate/audit/restart → affected Stage `resume` / `replan` / `restart` |
| 当前 Delivery cycle 全部计划内 Stage = `STAGE_ACCEPTED` | MES terminal fact | 记录该 cycle 的 `PROJECT_READY`；提醒 PM；历史 terminal 按自身 basis 保留，产品验收由用户完成 |

### 3.1 Event-local fresh-read pointers

以下 pointer 绑定真实事件；事件发生时先 fresh-read 唯一 owner，再沿本节 Trigger → Flow → Exit 执行。普通同一 Flow 内连续动作不要求重读全部 Contract。

| WHEN | READ |
|---|---|
| `CANDIDATE_PLAN_READY`、SPV `FINDINGS` 或 Plan acceptance / continuation / close decision | `.agents/contracts/brain/agent-lifecycle.md`；Planning 方法另读 `.agents/skills/proofloop-plan/SKILL.md` |
| `SLICE_CANDIDATE_READY`、CV dispatch、CV `FINDINGS` 或 repair/recheck | `.agents/contracts/brain/agent-lifecycle.md` + `.agents/skills/proofloop-execute/SKILL.md`；CV schema 读其 template |
| Result acceptance、lifecycle continuation、recall/reset 或准备 `herdr_link_close` | `.agents/contracts/brain/agent-lifecycle.md` 对应 role row；NORMAL durable Result/Finding write 另读 `.agents/contracts/brain/mes.md`，Git transaction 另读其 owner |
| MES read/write/status decision | `.agents/contracts/brain/mes.md` |
| Git boundary request 或 candidate freeze | `.agents/contracts/brain/commit-boundary.md` |
| `READY_TO_INTEGRATE`、Integration request 或 Integration failure | `.agents/contracts/brain/integration.md`；生命周期判断另读 `.agents/contracts/brain/agent-lifecycle.md` |
| Stage Review dispatch/result/recheck | `.agents/contracts/brain/stage-review.md`；retain/close/reset 另读 `.agents/contracts/brain/agent-lifecycle.md` |
| Finding 跨 binding boundary 或同一 failure family 再现 | `.agents/contracts/brain/finding-convergence.md`；首次局部 Finding 继续既有 arbitration route |
| `TECHNICAL_UNKNOWN` | `.agents/contracts/brain/technical-unknown.md` |
| Agent/Host/Link loss、binding invalidation、cancel/reset/recovery | `.agents/contracts/brain/agent-lifecycle.md` + 当前 branch owner；先从 durable facts 重建 currentness |
| context/tool-output pressure | `AGENTS.md` 的 context cleanup 规则；只调用 `ctx_reduce`，不推导 Agent completion |

`PLAN_READY`、Task 完成、CV `PASS` 和 `INTEGRATED` 都只触发各自表中的下一
边界，不越过未完成的 Flow。SPV、CV 和 Stage Reviewer 的 claimed route 不能绕过
Brain arbitration 直接驱动迁移。

## 4. Cross-Flow transitions and completion

- Propose 只以四类 canonical Authority 与统一的 `PROPOSE_READY` 结束，不增加
  Propose 内部 Gate。
- Planning 只有在 fresh SPV 返回 `PLAN_READY` 且 Brain 完成 Plan acceptance 后才
  允许 Execute；candidate Plan 不自动成为 accepted Plan。
- Execute 只有在全部计划内 Slice 通过独立 CV、完成 Integration 并达到
  `EXECUTION_READY_FOR_REVIEW` 后才进入 Stage Review。
- Stage Review 只有在三轴 Outcome、Composition、Authority 全部通过并绑定当前
  integrated snapshot 后才写 `STAGE_ACCEPTED`。
- finding 必须先回 Brain；Brain 不使用模糊的“当前 Authority”自行解释，也不在 workflow 复制 phase 到 Authority 文件的映射；Brain 使用 current Flow binding + canonical Contract/Skill pointer 取得 normative basis，再结合 current MES/Git/code reality 做 disposition，再选择 repair、Replan、Propose、Research/Prototype、局部 `HUMAN_REQUIRED` 或 recovery。workflow 不成为第二个 Authority mapping owner。
- Formal `AUTHORITY_GAP` remains a Planning/SPV route: it covers PRD→tech-spec omission/contradiction or unchanged Product intent whose bounded current code/runtime reality invalidates or proves insufficient the current Technical Authority. Brain routes it to the current Propose owner; implementation choice, feasibility uncertainty, and Runtime defect remain `PLAN_GAP`, `TECHNICAL_UNKNOWN`, or normal repair routes.
- After an authorized Authority owner completes a bounded update, Brain fresh-reads the canonical package, accepts the exact update, and uses `authority-update` as the mechanical Git boundary. This is not a new phase or approval Gate.
- `S06 MES integrity hard-freeze` is a higher-priority blocker over any stale/public `EXECUTE` projection: no S06 NORMAL Worker/CV/Integration/Review, no new Work/Task/Result/Finding/Git operational facts, and no NORMAL PVR/PA/recovery-baseline write; only the Authority-defined `MES_MAINTENANCE` evidence-only branch may run after its exact entry tuple is fresh-verified and it must not materialize normal MES facts.
- User presence, a new user message, and ephemeral transport state are not Flow continuation prerequisites. Only a Brain-confirmed real `USER_DECISION_REQUIRED` forms local `HUMAN_REQUIRED`.
- `PROJECT_READY` 只关闭当前 Delivery cycle 的 planned Stage set；历史 terminal 按自身 planned set / delivery basis 保持有效，不派发 Project Reviewer，不新增
  Project Gate 或自动产品验收。历史 terminal 不单独决定当前 workflow 的终态；新的实质工作必须回到 Propose。
- Cross-Flow Context Rollover（跨 Flow 上下文切换）：Routing Boundary 已确认并选定 next Flow 后，Brain 按固定顺序切换工作集——保留 unresolved Finding/blocker、cross-Flow 仍需要的 handoff 与用户仍有效的目标/约束 → 用 `ctx_reduce` retirement 旧 Flow 已消费完的工作上下文 → fresh-read 下一 Flow canonical working set → dispatch。canonical working set 仍由本文件 §6 的 owner pointer 与各 owner 决定，本文件不复制其正文；同一 Flow 内的普通 continuation、Task Result、`TASK_RESULT_ACK`、ACK 不触发 rollover。
  `ctx_reduce` 是上下文 retirement 工具，不是 Flow Gate：它的可用性、调用结果与内容是否真正释放都不决定 transition 的合法性，也不是新的完成信号；不因 Flow 切换做 blanket drop，也不 retirement 未解决的 Finding/blocker、recovery/safety 约束或下一 Flow 仍需要的 verifier/reviewer evidence。Git/MES/Authority/Plan 中已存在的可重读事实靠 fresh-read 维持 currentness，不靠聊天上下文复制。

正确性验证不由本 Router 统一包办：每个事务在其 owner 的 Skill/Contract 中验证
自己的最小 currentness basis，并只在发生上述边界事件时把结果交回 Brain。

## 5. Global Dispatch Rule

Brain 只能发送：

- control：Flow 控制、生命周期决策等 Brain-owned routing 动作；
- stable identity/binding/refs：角色、binding、ref、digest 等可重读事实的引用；
- Brain-owned decisions/authorization：Brain 的决策与授权；
- mechanical launch 所需 ephemeral transport identity：Agent Name、`actionToken` 等临时路由 metadata（raw pane/tab/workspace ID 不进入 Brain-owned launch metadata；placement 由 Link 按 `with?` / `cwd?` 机械创建）。

禁止 Brain 重构 repository/MES/Git 中可重读的业务语义；可重读语义由 Authority、accepted Plan、MES facts 与 Git 各自持有，Brain 只引用、不投影副本。

### 5.1 NEW / FRESH / RECOVERY-new-agent 固定顺序

1. route boundary 选择 role/dispatch skill；
2. `config_agent := role_skill`；
3. 选择唯一 live Agent Name；
4. resolve launch binding：`with?` / `cwd?`；
5. 必要时激活 Herdr Link gateway；
6. configured start（`herdr_link_start(name, config_agent, with?, cwd?)`）；placement 由 Link
   机械创建，Brain 不持有 raw pane/tab/workspace ID；
7. start success 后 send minimal packet；
8. lifecycle 接纳 Result；`sent`/pane state/idle/done 不代表完成。

具体 dispatch：

- Planner：`start(name, config_agent="proofloop-plan")`
- SPV：`start(name, config_agent="stage-plan-verifier", with=plannerName)`
- Worker：`start(name, config_agent="worker", cwd=sliceWorktree)`
- CV：`start(name, config_agent="code-verifier", with=workerName)`
- Stage Reviewer：`start(name, config_agent="stage-reviewer")`
- `MES_MAINTENANCE`：复用 Worker/CV/Stage Reviewer 的 configured start；由 packet 的 `execution_mode`、maintenance binding 与 `cwd` 指向 isolated maintenance worktree/evidence root，不能转为 NORMAL，也不能用 General 替代 required Worker/CV/Reviewer execution lane。Stage Review 已返回并由 Brain 接纳 bounded implementation/composition Finding 后，允许一个独立的 post-Review General exception：General one-shot bounded repair → `direct-fix` → same maintenance Reviewer recheck；该例外不继承 Worker Slice lifecycle，不写 MES，也不改变 maintenance execution branch。
- General：`start(name, config_agent="general")`
- Researcher：`start(name, config_agent="researcher")`
- Prototype：`start(name, config_agent="prototype", cwd=prototypeWorktree)`

Worker/CV 不变式：one Slice = one Worker lifecycle = one isolated worktree = one Herdr tab。

Normal dispatch 不需要 `peers` 前置；`peers` 仅 address discovery / recovery。

本文件不复制 Herdr Link schema、CLI flags、round-robin 实现或 runtime 参数闭集；这些由 `.agents/agent_config.json` + Herdr Link 机械拥有。

## 6. Context pointers
本文件只提供路由入口。执行细节由以下唯一 owner 持有：

- Agent launch、`actionToken`、scope 和首个 Link packet：
  本文件 §5 Global Dispatch Rule；
- one-shot、continuation、review-loop、recovery、recall、reset、`MES_MAINTENANCE` evidence-only branch 及各分支的 currentness：`.agents/contracts/brain/agent-lifecycle.md`；
- MES facts、semantic transaction ownership、Result/Finding materialization、binding/relation validation 与 status observation：
  `.agents/contracts/brain/mes.md`；
- Git boundary：`.agents/contracts/brain/commit-boundary.md`；
- Integration 机械事务：`.agents/contracts/brain/integration.md`；
- Project Stage Map（Git-tracked public planning artifact，writer 为 Planner）：`delivery/project-stage-map.md`；
- Planner 方法、candidate Plan、SPV 与 Replan：`.agents/skills/proofloop-plan/SKILL.md`；
- Execute、Worker/CV lane、`MES_MAINTENANCE` evidence-only implementation、Integration 前置和 cleanup：
  `.agents/skills/proofloop-execute/SKILL.md`；
- General、Researcher、Prototype、CV、SPV 和 Stage Reviewer 的角色步骤：对应
  `.agents/skills/<role>/SKILL.md` 及其 packet/result Template；
- Finding convergence：当 verifier/reviewer Finding 首次跨越同一 work/transaction scope 的多个 binding-chain 边界，或 repair/replan 后同一 failure family 再现时，读取 `.agents/contracts/brain/finding-convergence.md`；首次局部、单一 owner 可完成的 Finding 继续使用既有 arbitration route。
- Brain host 只按本路径加载路由入口；Pi/OpenCode 提供宿主能力，不复制本 Contract
  的流程正文，不建立第二个 durable workflow/controller state。

## 7. Terminal and blocker discipline

- 当前 Delivery cycle 的全部计划内 Stage accepted 后，Brain 发起 `PROJECT_READY` semantic event，由 MES transaction layer materialize 该 cycle 的 terminal fact 并提醒 PM；maintenance Review 永不触发 `STAGE_ACCEPTED`/`PROJECT_READY`。
  PM 的最终产品验收在本自动流程之外。历史 terminal 按自身 planned set / delivery basis 保持有效，后续 cycle 可共存。
- 真实用户决策缺口才形成局部 `HUMAN_REQUIRED`，只影响受影响工作及其真实依赖后代；
  不把它当作全局终态。
- 用户离线或停止发送消息本身不触发 `HUMAN_REQUIRED`；只要 current binding、scope、Authority/Plan basis 与事务条件仍有效，当前 Flow 继续推进。
- `PROJECT_READY` 历史事实不单独构成当前 workflow 终态；新的实质工作、scope 增量或产品 intent 变化是新的 Routing Boundary，必须进入 Propose。
- 缺少或矛盾的事实、绑定、scope、transport 或验证条件必须返回对应 typed blocker，
  保留原始原因和恢复方向；不得以 Link 传输状态、pane 状态、进度投影或叙事补全。
- `MES_RECOVERY_REQUIRED` 只在 exact pre-image 不可得且 read-only audit 证明 current snapshot 不能作为 NORMAL baseline 时成立；它保持 global recovery blocker，直到合法 `recovery_baseline` 写入并 rehydrate/audit 通过。
- 旧 business-control CLI、Receipt、Manifest、Gate、Context credential、
  Primary Next Action 和 legacy recovery 只可在集中标注的 Historical/legacy 说明
  中出现，不构成当前 route。
