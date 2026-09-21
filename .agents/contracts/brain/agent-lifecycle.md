# ProofLoop Agent Lifecycle Contract

## 1. 目的、角色与生命周期归属

本 Contract 统一定义各 Host Role Agent 以及 Planner Agent 的 `one-shot`、`continuation`、`review-loop`、`recovery`、`recall/reset` 语义。它定义生命周期分支的校验和迁移，不规定模型推理、tool 顺序或每轮读取节奏。

Host Role Agent 与主 lifecycle 的固定映射：

| Host Role Agent | lifecycle | 典型行为 |
|---|---|---|
| `general` | `one-shot` | 一个 bounded direct request 返回一次 Result |
| `researcher` | `one-shot` | 一个外部技术研究请求返回一次带 sources 的 Result |
| `worker` | `continuation` | 同一 Slice lane 内执行被投影的 current Task，必要时 bounded repair；`MES_MAINTENANCE` 下只交付 Git/Subagent transport evidence，不写 MES |
| `prototype` | `continuation` | 同一 Prototype/Hard Part 绑定下继续，必要时调用 Researcher |
| `code-verifier` | `review-loop` | Slice 独立初审、finding、repair 后有界复查；`MES_MAINTENANCE` 下 evidence-only CV |
| `stage-plan-verifier` | `review-loop` | candidate Plan 与 referenced Map entry 独立验证；Plan 或 Map material revision 时 fresh full initial |
| `stage-reviewer` | `review-loop` | normal Stage 三轴初审、repair 后复查或 reset；`MES_MAINTENANCE` 下 evidence-only maintenance Review |
`proofloop-plan` 不是第八个 Role；它是 Planning phase dispatch，runtime label 为 `planner`，使用 `continuation`。Planning 的 candidate Plan 在接纳前不要求 accepted Plan；SPV 严格绑定 candidate Plan + referenced Map entry + Authority + exact candidate Git tuple，任何 Plan 或 Map material revision，或 candidate Plan / referenced Map entry / Authority / Git tuple 变化都要求新的 SPV fresh full initial 验证。Planner 的实际步骤来自所选 Host 的 `proofloop-plan.md`。

## 2. Branch-scoped validation

生命周期不设一个覆盖所有事件的全局 preflight。每个事务只验证自己的最小
currentness basis：

| 分支/事务 | 必须验证的最小 basis | owner |
|---|---|---|
| `NEW` / `FRESH` / `RECOVERY-new-agent` dispatch | 当前 Host Role/Planner document、binding、scope、Subagent host/transport 与 dispatch packet（launch mechanics 遵循 Host Brain document 指引） | `.opencode/agents/brain.md` 或 `.pi/brain-workflow.md` |
| `MES_MAINTENANCE` dispatch | current integrity blocker, physical quarantine, exact frozen/forensic/audit tuple, recovery candidate + fresh SPV `PLAN_READY`, Brain bounded authorization, role/packet/scope/Subagent host binding | Host Brain + Execute/Worker/CV/Stage Review Contracts |
| Result acceptance | role template schema、`actionToken`、Result identity、Stage/Slice/Task/Plan binding、mode-specific digest/binding、scope 与该 Result 的 Git/事实 basis；`NORMAL` durable materialization 由 MES transaction layer 完成，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 只由 Git/Plan/evidence 复核 | Brain + 对应 Result Contract + MES transaction owner |
| review `RECHECK` | reviewer identity、review target/basis、repair scope、repair diff、required criterion、mode/maintenance binding（如适用）与 read-only 条件 | lifecycle + 所选 Host Reviewer document |
| `RECOVERY` | 受影响的 durable facts、binding、scope、Git reality、Result/Finding 与当前 peer 能力；`MES_MAINTENANCE` 另须 frozen snapshot exact digest/count、forensic/audit refs 与 quarantine | Brain + 本 Contract |
| Worker continuation | 同一 Slice lane、mode-specific Plan/Authority/Git basis、scope 和上一个 Result/ACK 状态；Task JIT Read Set 由 Brain running `proofloop-execute` 每个 Step 投影、Worker 只消费；`MES_MAINTENANCE` 还须 maintenance binding 与 Brain bounded authorization current | Host Worker document + Execute phase |
| Planner continuation | 同一语义 Planning basis：Project Stage Map 路径（`delivery/project-stage-map.md`）及当前 Git basis 下的 current Stage entry、Stage / dependency-ready 选择、candidate Plan target / binding、Authority refs、相关 code reality、branch、trust root 和合法 planning write scope | Host Planner document + 本 Contract |

上述 branch guard 不是模型循环。普通 continuation、普通 Task Result、ACK 和同一
Flow 内部迭代由当前 Flow/Contract 继续处理；不因 `idle`、`done`、暂时无 action
或 transport `sent` 自动关闭或重新派发。

User presence is not a lifecycle condition: a user who stops sending messages does not create `LOSS_DETECTED`, `HUMAN_REQUIRED`, or a new Routing Boundary. If the current binding, scope, Authority/Plan/Git basis, and transaction conditions remain valid, the current Flow continues. Only a Brain-confirmed real `USER_DECISION_REQUIRED` creates a local human pause; ordinary Authority repair returns through the Propose owner and `authority-update` without an extra user checkpoint.

以下事务型 freshness 仍然有效，但只在对应事件触发：

- `NEW`/`FRESH`/`RECOVERY-new-agent` 的 launch mechanics 遵循 workflow Contract 指引；运行中的
  Agent 保留启动配置，不热切换；
- finding disposition 验证当前 Authority、Plan、scope 和 code reality；
- Integration 验证当前 Git/current binding；
- recovery 重建受影响 durable facts 与 binding；
- Plan 或 Map material revision，或 candidate Plan + referenced Map entry + Authority + exact candidate Git tuple 发生任何变化，SPV 对新 tuple 执行 fresh full initial；
- Worker 每个 Task 的 JIT Read Set 由 Brain running `proofloop-execute` 每个 Step 投影，Worker 只消费。

## 3. Lifecycle policy matrix

| role_or_dispatch | retain_until | continuation_trigger | close_when | reset_when |
|---|---|---|---|---|
| `general` | legal Result 被 Brain 接纳 | —（one-shot） | legal Result 经 schema/binding 校验并被接纳 | binding、identity 或 Result 失败 |
| `researcher` | legal Result 被 Brain 接纳 | —（one-shot） | legal Result 经校验并被接纳 | binding、identity 或 Result 失败 |
| `proofloop-plan`（`planner`） | Brain 接纳 `PLAN_READY`/accepted Plan，或 Planning cancel/reset/binding 失效 | bounded Planning/revision；SPV `FINDINGS` 被归类且语义 basis 仍 current | 仅 retain 终点成立时关闭 | 语义 Planning basis、identity 或 snapshot 失效 |
| `worker` | 整个 Slice：Task loop、candidate ready、CV finding/repair/recheck 直到当前 mode 的 CV PASS 被接纳且 candidate ref durable | 每个 accepted Task Result/ACK，在同一 Slice lane 内继续至 `SLICE_CANDIDATE_READY`；CV dispatch、finding 和 bounded repair 不关闭 Worker lifecycle；`MES_MAINTENANCE` 的 ACK/Result 只接纳 evidence | Brain 接纳 CV PASS、candidate ref durable，达到对应 mode 的 `READY_TO_INTEGRATE`，且无 pending repair/recovery；maintenance 不写 MES；或显式 cancel/reset/binding invalidation | binding、identity、snapshot 或 maintenance tuple 失效 |
| `proofloop-execute (MES_MAINTENANCE)` | maintenance branch：全部 evidence-only Slice lifecycle 到 maintenance Review | dependency-ready Slice lane；Worker/CV/Integration/cleanup 均按 maintenance binding 继续 | Brain 接纳全部 maintenance Review evidence，且无 pending Slice/repair/recovery；随后进入 controlled-recovery decision，不写 MES | recovery tuple、Plan/Authority/Git basis、quarantine 或 Brain authorization 失效 |
| `prototype` | Prototype continuation 或 Researcher detour 期间 | technical result 后 Prototype basis 仍 current | legal terminal technical Result 被接纳 | binding、identity 或 snapshot 失效 |
| `code-verifier` | finding → repair/recheck 全程 | bounded repair 后，在同一 review basis 下继续；`MES_MAINTENANCE` 保持 frozen/forensic/audit + live Git basis | Brain 接纳 CV PASS 且 candidate ref durable，达到对应 mode 的 `READY_TO_INTEGRATE`，且无 pending repair/recheck；maintenance PASS 只形成 evidence，不写 MES；或显式 cancel/reset/binding invalidation | binding、identity、review basis 或 maintenance tuple 失效 |
| `stage-plan-verifier` | 当前 candidate verification cycle | Plan 或 Map material revision 仅复用 transport identity，必须对新 tuple（candidate Plan + referenced Map entry + Authority + exact candidate Git basis）fresh full initial | Brain 接纳 `PLAN_READY` 并建立 accepted Plan | binding、identity、referenced Map entry 或 candidate tuple 失效 |
| `stage-reviewer` | normal Stage 或 maintenance evidence review 的 finding → repair → recheck 全程 | repair 后的 bounded recheck；maintenance 绑定 Git evidence + frozen/forensic/audit | normal `STAGE_ACCEPTED` 被 Brain 接纳，或 maintenance Review evidence 被 Brain 接纳且不写 MES | binding、identity、review basis 或 maintenance tuple 失效 |

`SLICE_CANDIDATE_READY`、CV dispatch、finding、单个 Task、`idle`、`done` 和暂时无
下一动作均不是 Worker/CV lifecycle 的 close predicate。Integration 与
`INTEGRATED` 是 Brain/Host 的下游事务，不是 Worker/CV close 的替代条件。

Planner 的 `CANDIDATE_PLAN_READY` 只结束当前 action；Planner 保持 continuation 或
passive 状态。在 map-absent 分支下，Planner 创建 `delivery/project-stage-map.md`
属于本 action 的合法 output，不因自身输出自动使 Planner 失效；候选 Map 与 candidate
Plan 在机械 Git boundary（如 `stage-plan` boundary）内容不变时保持 live/passive 状态。
外部 Authority、Map、Stage selection、相关 code reality、branch、trust root 或合法
scope 的真实变化使旧 Planner fail closed。没有新的 Planner instruction、`idle`、`done`
或 transport `sent` 不能单独关闭 Planning lifecycle。

## 4. Result binding 与接纳

Result 只能由当前 Subagent result 加对应 role template 进入 lifecycle。Brain 在接纳或
继续 dispatch 前，按当前 branch 校验：

- `actionToken` 必须由 Brain/Host 在 `NEW`、`FRESH` 或 `RECOVERY-new-lane` 建立
  dispatch/lane binding 时新生成，并匹配当前 packet；同一合法 lane 复用，旧 lane
  token 在 fresh/recovery/rebind 后失效；
- Agent 不生成、不裁剪、不从 Subagent type、agent_id、session_id、transcript、transport message id 或其他
  transport id 派生 token；不能证明新 token 对当前 lane 唯一时 fail closed，返回
  已有 typed `RUNTIME_BLOCKER` 或 `RESULT_BINDING_MISMATCH`；
- Result 的 role schema、闭集字段、scope、Stage/Slice/Task、mode-specific Plan/Authority、Git basis 与当前 transaction/recovery basis 必须一致；Result id/digest 仅在对应 role template 或 MES fact kind 明确定义时校验。对 `fact_kind: result`，仍执行 MES Contract/Runtime 现有 identity/digest 规则；通用 lifecycle 不为没有这些字段的 Reviewer envelope 发明 identity/hash；SPV Result 必须严格绑定 candidate Plan、referenced Project Stage Map entry 与 exact Git basis；`MES_MAINTENANCE` Worker/CV/Review Result 必须额外绑定 frozen/forensic/audit tuple 与 quarantine/Brain authorization。
- 缺失、截断、重复、unknown key 或 schema 错误返回 `RESULT_INVALID`；binding、snapshot、token 以及对应 schema 已定义的 digest 错误返回 `RESULT_BINDING_MISMATCH`；两者均 no-write；
- reply 只出现一次且关联当前 packet；`sent`、session 状态、Agent state、claim clarification 和
  Git diff 不代替 Result。

`NORMAL` 下 formal Result 由 Brain 校验并转化为经授权的 semantic event，由 MES operational transaction layer materialize；Brain 不组装 full snapshot、retention 或 canonical relation identity。一次性
`PRE_MES_BOOTSTRAP` 下允许的 Planner/SPV/CV/首个 MES-persistence Worker Result 是结构化 Subagent transport evidence，由 Git + Git-tracked Plan + canonical Authority 复核，不写 MES、不指向 MES `resultRef`；只在 MES persistence 集成并 seed 前、且只对首个 MES-persistence Stage 合法，seed 后永久禁止并恢复 `NORMAL`。
`RECOVERY_REBASELINE` 下 Planner/SPV Result 与 `MES_MAINTENANCE` 下 Worker/CV/Review Result 都是结构化 Subagent transport evidence：前者绑定 recovery-aware candidate Plan、Map/Authority/Git exact tuple，后者绑定 recovery candidate、current Authority/Git、frozen/forensic/audit exact tuple 与 bounded authorization；两者都不要求或声称 current NORMAL MES work identity/resultRef。`PLAN_READY` 在 maintenance/recovery Authority closure、isolated implementation/CV/Review、fresh exact-bound recovery candidate/SPV 与 controlled recovery transaction 之前不 materialize 为 MES PVR/PA 或 `recovery_baseline`。
Stage Reviewer envelope 按 `.agents/contracts/brain/stage-review.md` 作为 Brain 接纳前的 role-specific structured input，不要求预先存在 durable `resultRef`；只有 normal Stage Review 且 Brain 发起对应 semantic event 时，MES transaction layer 才按 fact kind materialize `fact_kind: result`、Finding/Stage relation 与既有 identity/digest 规则。Maintenance Review 只接纳 Git/Subagent transport evidence，不 materialize MES Finding/Stage/terminal fact。accepted Stage/Finding 支持事实所需的 `result_ref` 由 transaction layer 从 canonical durable relation 产生或 exact-validate。

### 4.1 Worker Task Result ACK

Worker 在 Slice lane 内执行被投影的 current Task。每个 Step 由 Brain running `proofloop-execute` 读取完整 accepted Plan、选择当前 dependency-ready Task、并只把该 Task 的 JIT input 投影给同一 Worker；Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body。Brain 只接纳 Result 并返回非 durable、
closed `TASK_RESULT_ACK`：

```yaml
kind: TASK_RESULT_ACK
executionMode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
stageId: <stage-id>
sliceId: <slice-id>
taskId: <task-id>
actionToken: <current Slice-lane dispatch token>
resultId: <opaque id from submitted Task Result>
resultDisposition: ACCEPTED | REJECTED
continuationDisposition: CONTINUE | PAUSE
acceptedResultRef: <NORMAL + ACCEPTED only>
validatedGitBasis: <validated Result/evidence basis>
reasonCode: <required for REJECTED or PAUSE>
```

只允许 `ACCEPTED + CONTINUE`、`ACCEPTED + PAUSE`、`REJECTED + PAUSE`。ACK 不得包含 `next_task_id`、`next_action`、`recommended_action`、producer instruction、Receipt、Gate 或 admission credential。`NORMAL + ACCEPTED` 必须有 `acceptedResultRef`；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 或 REJECTED 禁止该字段；`validatedGitBasis` 必填；`MES_MAINTENANCE` 的 ACK 只表示 Brain 接纳 Git/Subagent transport evidence，不表示 MES Task completion；`ACCEPTED + CONTINUE` 不得有 `reasonCode`。

每个新 Result attempt 使用新的 `resultId`；同 payload 重放复用原 id，修正后的 retry
使用新 id。同一 id + 相同 binding/payload 必须幂等返回原 disposition；同一 id +
不同 payload 返回 `RESULT_INVALID`；stale token 返回 `RESULT_BINDING_MISMATCH`。
ACK 丢失或 Brain 重启时，`NORMAL` 从 MES 重建等价 ACK；bootstrap 从 Git、Plan 和当前 evidence 重建；`MES_MAINTENANCE` 从 recovery Plan、Git refs/commits、frozen digest/count 与 forensic/audit 重建，不创建 ack-log、maintenance result store 或第二 result store。

每个 Step 由 Brain running `proofloop-execute` 从当前 mode 绑定的 Plan 当前 Slice 的稳定 task order 选择第一个 incomplete 且 dependencies 已有被当前 mode 接纳的 outputs、scope/binding current 的 Task，并只把该 Task 的 JIT input 投影给同一 Worker；`NORMAL` predecessor output 来自 MES durable facts，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` predecessor evidence 从 Git + Plan/evidence 重建；不得越过未接纳 predecessor。Brain 不在 ACK 中携带下一 Task 指令。

## 5. Continuation branches

### 5.1 Worker

Brain 只启动一次 Slice lane，按当前 mode 投影 Slice-level Work Packet 和首个 dependency-ready Task 的 JIT Read Set；lane 启动后，Brain running `proofloop-execute` 每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、并只把该 Task 的 JIT input 投影给同一 Worker。Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body；每个 Task 开始时读取 Execute 投影的 JIT Read Set、Plan/Authority/Git basis 与依赖输出，提交 Result 并等待 Brain 的 closed ACK。`NORMAL` 的 ACK/Result 由 MES transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 的 ACK/Result 只接纳 Git/Subagent transport evidence。ACK 接纳后 Worker 继续，直到 self-check 通过返回 `SLICE_CANDIDATE_READY`；Brain 随后按 mode 路由 CV。Task 边界：每个 Task 必须自足（local closure / verification closure / future-HOW independence），自然 TDD（RED → 最小实现 → GREEN）属同一 Task 的 HOW，不跨 Task 切碎。

Worker 有 durable code、Evidence 或 projection 而 Agent 丢失时，Brain 使用当前 mode 的 `recover-task`，保留已有成果，重新校验 root-bound scope/binding，不重新实现已有工作；`MES_MAINTENANCE` 还必须重建 frozen/forensic/audit tuple 与 maintenance authorization。Result 缺失或未接纳时 lane 暂停，不得自主越过 barrier。

### 5.2 Planner 与 SPV

Planner continuation 绑定同一语义 Planning basis：
- Project Stage Map 路径（`delivery/project-stage-map.md`）及当前 Git basis 下的 current Stage entry（`project_stage_map_ref`）；
- Stage 与 dependency-ready 选择；
- candidate Plan write target 与 binding；
- canonical Authority refs 与 digests；
- 当前相关 code reality；
- 当前 branch、trust root 与合法 planning write scope。

在 map-absent 分支下（active `delivery/project-stage-map.md` 缺失），Planner 首次创建公共 Map 属于本 action 的正向 output，不因自身写入 Map 输出而自动判定为 basis 变化使 Planner 失效。

`stage-plan` mechanical Git boundary 只记录相同 candidate blob（包含 candidate Plan 与 candidate Map entry）推进 HEAD 时，内容未发生实质变更，不单独使 Planner continuation 失效；候选 Map 与 candidate Plan 在机械 Git boundary 前后保持 live/passive 状态。

外部 Authority、既有 Map、Stage selection、相关 code reality、branch、trust root 或合法 planning write scope 发生真实变化时，旧 Planner 必须 fail closed，进入 fresh/recovery，不沿用旧结论，也不依赖 hidden session 恢复。accepted Plan binding 建立后，当前 Stage Planning 正常关闭。

SPV 与 Planner continuation 严格解耦，不享有语义宽容度。SPV 严格绑定四元组：
`candidate Thin Plan + referenced Project Stage Map entry (at same Git basis) + canonical Authority verification basis + exact candidate Git basis`。
Plan 或 Map material revision，以及上述 tuple 中任一要素的变化，都必须对新 tuple 执行 fresh full initial 验证；同一 SPV Agent 只可作为 transport convenience 继续，严禁复用旧 verdict 或执行增量复查。若 candidate Plan 缺失 `project_stage_map_ref`、在同一 Git basis 下无法重建 referenced Map entry，或 Map entry 与 candidate Plan 语义矛盾，SPV 必须判为 fail closed / BLOCKED。

### 5.3 Prototype 与 Researcher

Prototype 返回 `RESEARCH_REQUIRED` 时，Brain 先验证原 Prototype binding，再以
one-shot lifecycle 派发 `researcher`。Researcher Result 接纳后，只有 Prototype ID、
Hard Part、worktree、Base Ref、Validation Question、Plan 和 snapshot 仍 current，
原 Prototype 才可继续；否则 fresh/recovery。Researcher 不变成长驻协作者。

## 6. Review-loop branches

`code-verifier`、`stage-plan-verifier` 和 `stage-reviewer` 的共同形状是：

```text
INITIAL_REVIEW → FINDING → BRAIN_ARBITRATION → optional claim clarification → disposition → repair/replan/overreach/block → RECHECK when valid
```

（`BRAIN_ARBITRATION` 是 contract sequencing 语义，不增加新的 durable MES 状态机。）

Reviewer 在 `INITIAL_REVIEW` 先独立读取目标、对应 Plan、Technical Authority、Git basis 和真实 artifact，全程 read-only。
Reviewer 提出 finding 后，finding 统一返回 Brain 进行 normative arbitration。Brain 依据 accepted Plan、Technical Authority（tech-spec）和真实代码进行规范仲裁（normative arbitration：Reproducibility alone is not normative support）。
Brain 可按需向 Reviewer 发起 optional claim clarification：
- claim clarification 只允许说明 problem claim、concrete evidence 和 normative basis；
- 禁止把 clarification 变成 Reviewer ↔ repair owner 的实现设计对话；
- Reviewer 的 suggested solution 仅作参考，不构成 implementation design authorization，Reviewer 不拥有 mandatory repair HOW；
- clarification 绝不产生 PASS、PLAN_READY、STAGE_ACCEPTED、MES 记录或业务状态。

Brain 形成 FINDING_DISPOSITION：
- 若缺乏规范依据判定为 `VERIFIER_OVERREACH`，作为有效终止 disposition 驳回该 finding（`accepted_route_code = null`，无 producer repair，无 current-stage Replan，不触发 `HUMAN_REQUIRED`）；
- 若接纳 problem claim，Brain 确定 route 并指派 repair owner（如 General 或 Worker）或 route Planning / Research；
- repair owner 自主决定 bounded HOW，Brain 与 Reviewer 均不替代 repair owner 构造 technical repair design。

Repair owner 完成修复后，Brain 只重读本次 recheck 所需的 Git、Result/Finding、Plan、Authority 和 basis，并按以下条件选择 continuation 或 fresh：

- `code-verifier` / `stage-reviewer`：target/basis、Stage/Slice/Plan/snapshot、identity
  和 clean-room 条件均未改变，且 Reviewer 仍 read-only → 同一 Reviewer 做 bounded
  incremental recheck，只覆盖既有 finding、失败 criterion、repair diff 和 required
  scope；
- `stage-plan-verifier`：任何 Plan 或 Map material revision，或 candidate Plan + referenced Map entry + Authority + exact candidate Git tuple 发生任何变化，都创建 fresh full initial 验证；同名 Agent continuation 只复用 transport，不复用旧 verdict；
- Reviewer、session/transcript/transport trust 丢失，target/basis/Goal/Authority/Plan 重大变化，
  Reviewer 写 artifact，`clean_room = yes` 或 Result/binding 无法完整重读 →
  `REVIEW_RESET_REQUIRED`，建立 fresh Reviewer 并重新独立初审。

Review Result 只有在 schema/binding、currentness 和对应持久化/证据步骤完成后，才产生对应的 `PASS`、`PLAN_READY` 或 normal `STAGE_ACCEPTED` 业务事实；`MES_MAINTENANCE` 的 `PASS` 是 evidence-only，不产生 MES 业务事实。`FINDINGS`、`BLOCKED`、bare `PASS`、claim clarification、`idle`、`done` 均不单独关闭 review lifecycle。

## 7. Recovery

统一恢复路径为：

```text
LOSS_DETECTED → REHYDRATE → BINDING_CHECK → RECOVER | REUSE | FRESH
             → RESULT_REVALIDATE → NORMAL: MES | PRE_MES_BOOTSTRAP: Git + Plan | RECOVERY_REBASELINE: Forensic + Audit + Plan/Git | MES_MAINTENANCE: Recovery Plan + Git + frozen/forensic/audit
```

`LOSS_DETECTED` 包括 Agent/session/transcript 丢失、Brain 重启、Subagent result 丢失和 Host
退出。Brain 只从受影响 role 的 durable facts 重新计算动作：

- `NORMAL`：MES facts、`delivery/project-stage-map.md`（active Map entry）、Planner candidate Plan（含 `project_stage_map_ref`）或 Execute/CV/Review accepted Plan、Authority、structured Result/Finding 与 Git/worktree reality；`MES_MAINTENANCE` 不读取 normal work/result facts。
- `PRE_MES_BOOTSTRAP`：Git-tracked Plan、`delivery/project-stage-map.md`（由 bootstrap Planner 首次创建后）、canonical Authority、结构化 Subagent transport evidence 与 Git/worktree reality，不读取或声称 MES facts。
- `RECOVERY_REBASELINE`：root-bound forensic incident + read-only audit + current recovery Authority + candidate Plan/Map/Git tuple；`MES_MAINTENANCE`：recovery candidate Plan + current Technical Authority + Git candidate/integration evidence + frozen snapshot exact digest/count + forensic/audit refs + Brain bounded authorization；两者不读取或声称 current NORMAL MES work/result，`PLAN_READY` 在 baseline/maintenance evidence closure 前不写 MES。

| 场景 | 合法动作 | 关键条件 |
|---|---|---|
| Worker 有 durable code/Evidence，Agent 丢失 | `recover-task` | 保留现有成果；重新验证 root-bound scope/binding |
| Worker/Prototype Agent 仍 live 且 binding/identity current | `reuse` continuation | 重新发现 peer；无 in-flight/pending Result |
| Reviewer session/Agent 丢失或 trust 不可证明 | fresh Reviewer | 完整独立初审；不恢复历史未接纳推论 |
| One-shot 缺少有效 Result | fresh one-shot 或 typed blocker | 不把旧状态当完成 |
| binding/scope/snapshot/target/basis（含 Map basis）改变或缺失 | `fresh` 或对应 recovery | 返回 `LIFECYCLE_CONTINUATION_BLOCKED` 或 `REVIEW_RESET_REQUIRED`；不依赖 hidden session |
| MES integrity hard-freeze / NORMAL writer unsafe | remain quarantined；Authority closure 后进入 bounded `MES_MAINTENANCE` recovery seam | public status is observation only；no NORMAL PVR/PA/recovery-baseline, no normal dispatch/retry/history surgery；exact frozen digest/count + forensic/audit + Git basis + fresh SPV `PLAN_READY` + bounded authorization required |

Recovery 不覆盖用户已有 code、Evidence、projection 或其他 durable artifact；不使用
checkout、重写、stash 或隐藏 session 清理未知状态。若 Map basis 丢失或无法从 candidate Plan
与 Git basis 重建，直接进入 recovery/fresh，不依赖 hidden session。不恢复旧 Subagent type/session、
session id、transcript、claim clarification、next-action 或 credential 链。

## 8. Recall 与 reset

在任何 Host Agent close 或 Agent recall 决策前，Brain 必须按以下顺序执行：
1. resolve current role/dispatch 与 lifecycle branch；
2. fresh-read 本文件 §3 `Lifecycle policy matrix` 的对应 row；
3. 验证该 row 的 `close_when`，或验证显式 cancel/reset/binding invalidation/recovery termination branch；
4. 只有 close 条件成立且没有 pending action/reply 时才调用 Host Agent close；否则 retain/continue。

§3 matrix 是 retain/continuation/close/reset 的唯一 normative owner；本节不重复 role-specific close predicate。

单个 Task 完成、`idle`、`done`、暂时没有下一个动作或 transport `sent` 都不能触发 recall。关闭使用稳定 Subagent type/session；Subagent transport 只传消息，不负责业务完成判断。

Reset 是旧 lifecycle 失效后的 fresh boundary，不是静默续接。Brain 先保留并重读已存在
的 durable work（含已落盘的 Map 与 Plan 草稿），再按 workflow §5.1 固定 dispatch 顺序
启动新 Agent（placement 由 Subagent host 机械创建，Brain 不持有 raw host session/worktree identity）；旧 Subagent type/session、
session/transcript、claim clarification 和旧 Result 不作为新 cycle 的 authority。

## 9. Lifecycle completion

每个 lifecycle decision 完成前，必须证明：

- 当前 branch 的最小 binding、Host Role document、Plan/Authority（SPV 包含 referenced Map entry）、Git basis 和
  scope 已由对应 owner 核对；
- branch 与当前 role、identity、snapshot、review basis 相符；
- Result 已完成 schema、digest、scope、唯一性和 `actionToken` 校验；
- formal 业务结论已经由 MES transaction layer 按模式 materialize，或 bootstrap evidence 已由 Git + Plan 复核，或 maintenance/recovery evidence 已满足其独立 seam 的 no-write/审计规则，或 typed blocker/no-write 已保留并给出恢复方向；
- 没有用 Agent narrative、transport delivery、session/transcript、claim clarification、checkbox 或 progress
  投影替代 MES/Git authority。
