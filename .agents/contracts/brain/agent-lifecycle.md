# ProofLoop Agent Lifecycle Contract

## 1. 目的与 ownership

本 Contract 只决定 Brain 下一次对一个 Role action 使用哪一种 lifecycle policy；它不定义 Role 的业务步骤、Result schema 的第二份副本、Host API 或 MES transaction。

- **Role procedure**：一次合法 bounded action 到达后，角色如何工作并返回 Result。
- **本 Contract**：下一次 action 是否 `one-shot`、`continuation`、`recheck` 或 `reverify`，以及 fresh-required 条件。
- **Host Brain**：把已获授权的 lifecycle decision 映射为 Pi/OpenCode native dispatch。
- **MES**：继续拥有 durable business state、work identity、Result/Finding 和 currentness。

以下不变量始终成立：

- `Lifecycle mode is Brain dispatch policy, not MES state.`
- `Host session identity does not create, replace, close, or authorize MES Work identity.`
- Host identity、lifecycle identity、MES identity 三者不可互换。
- MES identity 仍由现有 `delivery_cycle_id`、scope、`work_id`、Plan binding、Authority refs、Result/Finding、`actionToken`/`resultId`、Git basis 等 durable facts 和 binding 决定。
- `Host dispatch count ≠ MES work_id count`。同一 Worker Slice lane 可以经历多次 continuation，仍保持同一个合法 MES Work identity。
- Subagent 默认语义是：`dispatch → one bounded action → Result → 当前 invocation 结束`。`continuation` 只表示 Brain 下一次可以授权同一 logical owner 接收新的 bounded action，不表示 Agent 继续持有业务状态。

本 Contract 不把 `proofloop-execute (MES_MAINTENANCE)` 当作 Role。它是 orchestration branch；其 entry、execution、termination、recovery 由 `proofloop-execute` 和 MES/recovery Contracts 拥有。本 Contract 只约束该 branch 中实际被 dispatch 的 Worker、CV 和 Stage Reviewer。

## 2. 四种 lifecycle mode

| role | mode | reuse/continuation allowed when | fresh required when |
|---|---|---|---|
| `general` | `one-shot` | 不存在业务 continuation；当前 bounded request 的 Result 已被 Brain 接纳后 action 结束 | 新的业务 request、Result 缺失/无效、binding 或 scope 不可重建 |
| `researcher` | `one-shot` | 不存在业务 continuation；每个 external question 是独立 request | 新问题、版本/约束/basis 变化、Result 缺失/无效 |
| `frontend-execute` | `one-shot` | repair 由 Brain 创建新的 bounded request；不沿用原 executor action | 新的初始实现或 repair request、handoff/scope/snapshot/Authority/Git basis 变化 |
| `worker` | `continuation` | 同一 Slice lane；Plan/Authority/Git basis、root-bound scope、identity 与上一个 Result/ACK 仍 current；Brain 已有下一个 bounded Task 或已授权 repair | lane/binding/scope/basis 失效、Result/ACK barrier 无法重建、需要新 Slice 或新 Work identity |
| `proofloop-plan` | `continuation` | 同一语义 Planning basis；Brain 已授权新的 bounded planning/revision action | Stage/Map/Authority/code reality/branch/trust root/planning scope 等语义 basis 变化，或 Planner Result 无法重读 |
| `prototype` | `continuation` | 同一 Prototype/Hard Part、worktree、Base Ref、question、Plan/snapshot 仍 current；Researcher Result 已被 Brain 接纳 | Prototype binding、实验 basis、question 或 snapshot 变化，或 Result 无法重建 |
| `code-verifier` | `recheck` | fresh `INITIAL_REVIEW` 后，Brain 接纳 finding 并授权 bounded repair；review target/basis、identity/trust、read-only 条件仍 current | target、Plan/Authority/Git snapshot、scope、identity/trust、clean-room 或 Result binding 变化 |
| `stage-reviewer` | `recheck` | fresh `INITIAL_REVIEW` 后，Stage/maintenance target、review basis、identity/trust 和 read-only 条件仍 current；repair 已被 Brain 接纳 | Goal、Authority、Plan decomposition、integrated/maintenance snapshot、review scope、trust 或 binding 变化 |
| `frontend-review` | `recheck` | fresh `INITIAL_REVIEW` 后，handoff、review scope、surface meaning、implementation snapshot、evidence basis、identity/trust 仍 current | handoff、Authority、scope、surface meaning、snapshot、prototype binding、trust 或 evidence basis 变化 |
| `stage-plan-verifier` | `reverify` | 不复用任何 Host owner 或验证上下文；每个 exact tuple 都 fresh dispatch | 每个新的 exact candidate tuple 都 fresh full initial；tuple 为 candidate Thin Plan、referenced Project Stage Map entry、Authority verification basis、exact candidate Git basis |

`recheck` 和 `reverify` 都不是常驻 Agent 状态。它们是 Brain 对下一次 bounded review action 的 dispatch policy。

## 3. Dispatch policy

### 3.1 `one-shot`

一个 bounded request 只产生一个 Result。Result 被 Brain 按对应 schema/binding 接纳后，当前 action 结束。新的 request 必须 fresh dispatch；不存在通过旧 transcript、session 或模型上下文构造业务 continuation 的路径。

### 3.2 `continuation`

同一 logical owner 只有在下列事实全部可由 Brain fresh-read 时才具备 continuation eligibility：

1. 当前 Role 的 row 允许 continuation；
2. same Slice lane 或 same Planning/Prototype binding 仍匹配当前目标；
3. Plan、Authority、Git basis、snapshot、scope 和 identity 仍 current；
4. 前一个 Result/ACK 已被正确 consumer 接纳，没有跨越 pending barrier；
5. Brain 已形成新的 bounded action packet。

Host 仍存在的 session/handle 最多说明 mechanically resumable，不能单独证明 continuation 合法。任何条件无法闭合时，Brain 从 durable facts 选择 fresh、recovery 或 typed blocker。

Worker 的典型顺序是：

```text
Task Result
→ Brain schema/binding validation
→ ACCEPTED + CONTINUE
→ Brain projection of the next JIT Task
→ same logical Worker lane continuation
```

Worker 不选择 successor。Planner 在 candidate Plan Result 后可在语义 Planning basis current 且 Brain 有新 bounded planning action 时 continuation；Planner action 本身在返回 Result 时结束。

Prototype 的 `RESEARCH_REQUIRED` 只触发 Brain 派发 one-shot Researcher；Researcher Result 接纳后，原 Prototype 是否 continuation 由本节条件决定。

### 3.3 `recheck`

`code-verifier`、`stage-reviewer` 和 `frontend-review` 共享以下业务形状：

```text
fresh INITIAL_REVIEW
→ FINDINGS
→ Brain disposition
→ bounded repair
→ same-reviewer bounded RECHECK when basis is current
```

Role 只执行 initial review 或 bounded recheck 的审查步骤，并返回其 Result/verdict。Brain 负责 finding disposition、repair dispatch 和 fresh-vs-recheck decision。

同一 reviewer 只能重新读取既有 finding、failed criterion、repair diff、required recheck scope 和邻近影响面；不得把 recheck 扩展成新的初审、Plan revision 或实现设计。target/basis/identity/trust/read-only 条件变化时，下一次必须 fresh `INITIAL_REVIEW`。

Frontend repair 始终是 fresh one-shot `frontend-execute` request；repair Result 接纳后，只有 review basis current 时才允许原 `frontend-review` 做 bounded `RECHECK`。

### 3.4 `reverify`

`stage-plan-verifier` 的每个 exact candidate tuple 都执行：

```text
candidate tuple A
→ fresh SPV dispatch
→ full initial verification
→ FINDINGS or PLAN_READY

Planner revises any tuple member
→ candidate tuple B
→ fresh SPV dispatch
→ full initial verification from step 1
```

任何 candidate Thin Plan、referenced Project Stage Map entry、Authority verification basis 或 exact candidate Git basis 的变化，都属于新 tuple。禁止 incremental SPV recheck、old verdict carry-forward、只复查旧 finding 或为了 transport convenience 保留 SPV child/session。

## 4. Branch currentness 与 Result binding

生命周期不设覆盖所有事件的全局 preflight；每次 action 只验证自己的最小 basis：

| branch | 必须验证的 basis | owner |
|---|---|---|
| fresh/one-shot dispatch | 当前 Role document、request binding、scope、dispatch packet 和 Host dispatch capability | 所选 Host Brain |
| continuation dispatch | 对应 lifecycle row、同一 logical owner、current Plan/Authority/Git/scope、前一 Result/ACK barrier 和新的 bounded packet | Host Brain + 本 Contract |
| review recheck | reviewer identity、review target/basis、repair scope/diff、required criterion、mode/maintenance binding 和 read-only 条件 | Host Brain + Reviewer Contract |
| SPV reverify | exact candidate tuple、candidate Git basis、Map entry 可重建性、Authority refs 和 fresh initial packet | Host Brain + SPV Contract |
| Result acceptance | 对应 Role template/schema、`actionToken`、identity/binding、scope、Git/evidence basis 和 execution mode | Brain + 对应 Result Contract + MES transaction owner（适用时） |
| recovery | MES durable facts、Plan/Authority、structured Result/Finding、Git/worktree reality；maintenance 另需 frozen/forensic/audit tuple 和 quarantine | Brain + 本 Contract |

Core Delivery roles 使用各自 template/schema；frontend transport-only roles 使用本节定义的两个 closed envelope。缺失、截断、重复、unknown key、错误 binding、stale token 或无法证明 currentness 时 fail closed/no-write，返回既有 typed blocker；不能由 session、transcript、transport delivery、Agent state、Git diff、checkbox 或 summary 补全。

### 4.1 Frontend transport Result envelopes

Frontend envelope 不要求 Core Delivery 的 `Stage`、`Slice`、`Task`、`Plan` 或 `resultRef`，不 materialize MES/Core Delivery fact、Integration 或 Stage acceptance。

#### Frontend Execute Result

```yaml
kind: FRONTEND_EXECUTE_RESULT
actionToken: <current frontend request token>
frontendHandoffRef: tech-spec/frontend.md
scopeRef: <bounded frontend scope ref>
gitBasis: <implementation snapshot / current git basis>
outcome: COMPLETED | BLOCKED
changedPaths: [<root-relative path>]
evidence: [<actual check or evidence pointer>]
blocker: <required only when outcome is BLOCKED>
```

`changedPaths` 与 `evidence` 是 closed arrays；`blocker` 只在 `BLOCKED` 时出现。Envelope 不包含 Core Delivery identity、successor instruction 或 MES relation。

#### Frontend Review Result

```yaml
kind: FRONTEND_REVIEW_RESULT
actionToken: <current frontend review token>
frontendHandoffRef: tech-spec/frontend.md
scopeRef: <reviewed bounded frontend scope>
reviewedGitBasis: <exact implementation snapshot>
verdict: PASS | FINDINGS | BLOCKED
findings: [<closed finding object>]
evidence: [<actual evidence pointer>]
blocker: <required only when verdict is BLOCKED>
```

每个 finding object 只包含：

```yaml
affectedSurfaceStateViewport: <surface/state/viewport>
observedBehavior: <observable behavior>
normativeOrQualityBasis: <Authority or quality-floor basis>
evidence: <reproducible evidence pointer>
userVisibleConsequence: <user-visible consequence>
resolutionOracle: <condition proving resolution>
```

`FINDINGS` 的 findings 非空；`PASS`/`BLOCKED` 的 findings 为空；`BLOCKED` 必须有 blocker。

### 4.2 Result 与 action token

- `actionToken` 由 Brain/Host 在 fresh dispatch、fresh rebind 或 recovery-new-lane 建立 packet binding 时生成；合法同一 lane 的 continuation 可复用当前 lane token，fresh/recovery/rebind 后旧 token 失效。
- Agent 不生成、不裁剪、不从 `subagent_type`、`agent_id`、`session_id`、transcript、transport message id 或其他 transport id 派生 token。
- Core Delivery Result 的 role schema、closed fields、Stage/Slice/Task、mode-specific Plan/Authority、Git basis 和 transaction/recovery basis 必须一致。Frontend Result 按本 Contract 的 closed envelopes 校验。
- `NORMAL` formal Result 由 Brain 校验并转化为经授权的 semantic event，由 MES operational transaction layer materialize；`PRE_MES_BOOTSTRAP`、`RECOVERY_REBASELINE` 和 `MES_MAINTENANCE` 的对应 Result 只由 Git、Plan、Authority、forensic/audit 和当前 evidence 复核，不伪造 NORMAL MES facts。

### 4.3 Worker Task Result ACK

Worker 在 Slice lane 内只执行 Brain 投影的 current Task。每个 Task Result 由 Brain 校验后返回非 durable、closed `TASK_RESULT_ACK`：

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

只允许 `ACCEPTED + CONTINUE`、`ACCEPTED + PAUSE`、`REJECTED + PAUSE`。ACK 不携带 `next_task_id`、`next_action`、producer instruction、Receipt、Gate 或 admission credential。`NORMAL + ACCEPTED` 必须有 `acceptedResultRef`；bootstrap/maintenance 或 rejected 禁止该字段；`validatedGitBasis` 必填。

每个新 Result attempt 使用新的 `resultId`；同 payload 重放保持幂等，修正后的 retry 使用新 id；同 id 不同 payload、stale token 或 binding 不符必须 no-write。

## 5. Role procedure pointers

Role procedure is owned by the selected Pi/OpenCode Role document and the corresponding Skill. This Contract does not repeat RED/GREEN, Planner ordered steps, review-axis HOW, repair HOW or Result field schemas.

- `worker` continuation eligibility requires the same Slice lane, current Plan/Authority/Git basis, root-bound scope and accepted Result/ACK barrier. Successor Task and repair routing remain Brain/Execute decisions; multiple bounded actions do not create a new MES `work_id`.
- `proofloop-plan` continuation eligibility requires the same semantic Planning basis: current Map entry, Stage/dependency-ready choice, candidate Plan binding, Authority refs, code reality, branch, trust root and planning scope. A mechanical boundary for the same candidate blob does not by itself invalidate the basis.
- `prototype` continuation eligibility requires the same Prototype/Hard Part, worktree, Base Ref, question, Plan/snapshot and an accepted Researcher Result.
- `code-verifier`、`stage-reviewer`、`frontend-review` use their Role procedure for `INITIAL_REVIEW` or bounded `RECHECK`; finding disposition, repair routing and fresh/recheck eligibility remain Brain plus this Contract.
- `stage-plan-verifier` uses its Role procedure for full verification; every new exact candidate tuple is governed by `reverify` and fresh full initial verification.

## 6. Recovery 与 fresh boundary

恢复永远从以下事实重建：

```text
MES durable facts
+ current Plan / Authority
+ structured Result / Finding
+ Git/worktree reality
+ mode-specific forensic/audit facts when required
```

不能从 hidden session、old transcript、session existence、模型上下文、transport notification、Agent state 或旧 summary 推断业务 currentness。Host continuation handle 仍存在最多说明 mechanically resumable，必须先经过本 Contract 的 lifecycle authorization。

| situation | next policy |
|---|---|
| one-shot 缺少合法 Result | fresh one-shot 或 typed blocker |
| Worker 有 durable code/evidence 但 invocation 丢失 | current lane 仍合法时以 `recover-task` continuation，否则 fresh/recovery |
| Planner semantic basis current 且有新 bounded planning action | Planner continuation；否则 fresh Planner |
| Reviewer target/basis current 且 repair bounded | same-reviewer `RECHECK`；否则 fresh `INITIAL_REVIEW` |
| SPV exact tuple 任一成员变化 | fresh full `reverify`，从第 1 步开始 |
| binding/scope/snapshot/trust 无法证明 current | fresh 或对应 recovery；不错误续接 |
| MES integrity hard-freeze | 停止 NORMAL dispatch/continuation；仅按 Execute/MES Contract 进入 evidence-only `MES_MAINTENANCE` branch |

Recovery 不覆盖用户已有 code、Evidence、Plan projection 或其他 durable artifact；不使用 checkout、stash、隐藏 session 或旧 transcript 清理未知状态。`MES_MAINTENANCE` 的 Worker/CV/Stage Reviewer 只交付 Git/Subagent transport evidence，不写 NORMAL MES。

## 7. Lifecycle decision completion

每个 lifecycle decision 完成前，Brain 必须证明：

- 当前 mode、Role document、binding、scope、Plan/Authority、Git basis 和 execution mode 已 fresh-read；
- chosen Role 与 current lifecycle row、identity、snapshot/review basis 相符；
- Result 完成对应 schema、scope、token、唯一性和 currentness 校验；
- continuation、recheck 或 reverify 的所有授权条件已经闭合；
- formal business conclusion 已由 MES transaction layer materialize，或对应 bootstrap/recovery/maintenance evidence 已按其独立 no-write 规则保存；
- 没有用 Host identity、session/transcript、transport delivery、Agent state、claim clarification、checkbox 或 progress 投影替代 MES/Git authority。
