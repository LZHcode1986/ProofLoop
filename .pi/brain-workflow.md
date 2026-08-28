# Brain Workflow

Brain 是用户入口、全局路由器和 Runtime 事实的解析者。本文件是始终加载的路由索引：只定义触发条件、下一动作和恢复顺序；字段、状态、packet、Evidence、Receipt 与 Git 语义分别以当前 Contract、Skill、Template 和 Runtime 为准。

## 每轮控制循环

按顺序执行一个且仅一个 `Primary Next Action`：

1. **REHYDRATE**：读取请求、Git status/diff、Authority、当前 Stage、Manifest、Evidence、Receipts、Findings 和 `progress.md`。`progress.md` 只用于定位，不授权状态迁移。
2. **CLASSIFY**：确定请求属于 `DIRECT_BOUNDED_TASK`、`PRODUCT_OR_AUTHORITY_WORK`、`ACTIVE_STAGE_WORK`、`RECOVERY_OR_EXCEPTION`、`USER_DECISION` 或 `STATUS_OR_TERMINAL`。
3. **RESOLVE**：从 Runtime 当前 action、适用 Contract 和 active Skill/template 解析一个 owner；无法解析时返回 `PROTOCOL_DEFECT / NEXT_ACTION_UNRESOLVED`。
4. **EXECUTE**：只执行该 action，或请求一个用户决定；不得用叙事、checkbox、`idle`/`done` 或派生快照替代 Runtime 事实。
5. **ADMIT AND RE-READ**：将结构化结果交给正确的 Runtime consumer，重新读取持久化制品和 Git，再计算下一 action。

完成标准：当前 action 已被适用 consumer 接纳并产生可重读事实，或已返回带 `route_code`、`subtype`、`reason`、`invalidation_scope`、`resume_target` 的 typed blocker。

## 请求触发与路由

| 触发 | 路由入口 | 完成信号 |
|---|---|---|
| 产品范围、行为或验收需要建立/修改 | `.agents/skills/ai-structured-prd/SKILL.md` | `PRD_CONFIRMED` |
| 已确认 PRD 存在阻塞架构的产品级技术问题 | `.agents/skills/prd-to-tech-design-prep/SKILL.md` | `TECHNICAL_CLARIFICATION_READY` |
| PRD/技术澄清已就绪，需要架构、Contract、Hard Part 或 Work Item | `.agents/skills/prd-to-ai-architecture/SKILL.md` | `ARCHITECTURE_READY` |
| Work Item 已选定且需要 Stage 计划 | `.agents/skills/proofloop-plan/SKILL.md` | Runtime Stage Plan admission |
| Manifest 已 admission 且 Runtime 返回 Stage action | `.agents/skills/proofloop-execute/SKILL.md` | Runtime 下一 action / Stage Gate PASS |
| Stage Gate PASS 后需要目标评审 | `.agents/contracts/brain/stage-review.md` + Stage Reviewer | Stage Review Receipt |
| 任何授权变更需要成为 Git commit | `.agents/contracts/brain/commit-boundary.md` | Boundary CLI 结果，随后 Runtime admission |
| 没有 specialist、无 authority 影响且目标有界 | `.agents/contracts/brain/general.md` | General 结构化结果 |
| 所有 Stage 已 ACCEPTED 且 PRD 仍有效 | `.agents/contracts/brain/execute-project-acceptance.md` | `PROJECT_ACCEPTED` / typed recovery |

在 `PRD_CONFIRMED` 前不做方案研究、框架选择、API/Schema 设计或实现任务拆分。用户要求修改时回到拥有该阶段的 Skill；Runtime admission、Gate 和 Review 驱动的阶段不使用产品阶段确认步骤。

## Authority 与 Stage 顺序

### Authority readiness

```text
PRODUCT_DEFINITION
→ CONDITIONAL_TECHNICAL_CLARIFICATION（仅确有阻塞问题）
→ ARCHITECTURE
→ HARD_PART_VALIDATION（仅确有阻塞 Hard Part）
→ AUTHORITY_READY
```

若规划、执行或评审返回 `AUTHORITY_GAP` 或 `TECHNICAL_UNKNOWN`，回到对应 authority/Hard Part Skill；`resume_target` 只提供方向，不跳过 readiness predicate。

### Stage delivery

```text
STAGE_SELECTION
→ proofloop-plan / candidate Plan
→ Runtime compile + validate + Evidence skeleton
→ final stable Git boundary（clean worktree）
→ fresh SPV（当前 HEAD）
→ Runtime Stage Plan admission
→ `proofloop stage next`（只读 Primary Next Action；按 action 提供 Context input/ref）
→ Brain/Host 按 action 必要时调用 `proofloop context prepare` 并在 dispatch 前校验 Context
→ Worker 直接消费 supplied Context；CV 仅在未闭合 Evidence gate 的既定顺序内调用允许的 `context admit-refutation-observation`/`context show` seam；其他 Runtime admission 仍由 Brain 调用
→ proofloop-execute
→ Slice Commit → Integration → Stage Gate
→ Stage Review
→ `proofloop boundary close`（`boundary_type=stage-close`）或 `proofloop stage close`（按选定 close route）
→ progress snapshot → recompute
```

候选 Plan、Validator PASS 和 SPV `PLAN_READY` 都不授权执行；只有 Runtime Stage Plan admission 后才能生成 Context 并派发 Worker。规划顺序、candidate 边界和 admission 后 replan 纪律见 `.agents/skills/proofloop-plan/SKILL.md` 及其 materializer Contract。执行顺序、Action consumer 和恢复分支见 `.agents/skills/proofloop-execute/SKILL.md`。

### Stage Context handoff
`proofloop stage next` 在 vNext Runtime 中是只读决策：它取得唯一的 `Primary Next Action`，并可返回该 action 的 Context input/ref；它不持久化 Context。只有当前 action 需要一个可重读的 Context 时，Brain 才调用 public `proofloop context prepare`。当前 handler 并非只支持 Worker：Worker 走 `persistVNextWorkerContext`，其他闭集 role 走 `persistVNextRoleContext`；不要由 Brain 直接写 `.proofloop/context`。
Context 持久化后，Brain/Host 负责在 dispatch 前用对应 role/ref 读回并校验 supplied Context；Worker 直接消费该 Context，不调用 Runtime CLI；CV 仅在未闭合 Evidence gate 的既定顺序内调用允许的 `context admit-refutation-observation`/`context show` seam，其他 Runtime admission 仍由 Brain 调用。完成条件：`stage next` 的只读结果已核对；需要时 `context prepare` 已返回可重读的 ref/digest，且 Context binding 在 dispatch 前校验通过；Worker 已收到 supplied Context，或 CV 按其 gate 顺序返回结果/typed blocker。

Stage Gate PASS 后只进入 Stage Review；`ACCEPTED` 才能进入 Stage Close。Stage Review 的 verdict、Receipt 和 BLOCKED 语义只看 `.agents/contracts/brain/stage-review.md`。

### Stage close handoff
在 Gate `PASS` 与 Stage Review `ACCEPTED` 已分别由 Runtime 持久化后，正常 full close 走 `.agents/contracts/brain/commit-boundary.md`：Brain 调用 `node packages/runtime/dist/cli/proofloop.js boundary close --json '<stage-close request>'`，其中 `boundary_type` 为 `stage-close`。Boundary 在任何 Git 写入前重新核对 Gate/Review、集成 HEAD 和 Manifest-declared Evidence，成功返回带 `commit_sha` 的 Boundary 结果才算 Git close 完成。
`node packages/runtime/dist/cli/proofloop.js stage close --json '<stage-close request>'` 是另一条 Runtime P-11 close-fact 入口；选定该 full/restricted 路由时由 `admitVNextStageClose` 写入 `STAGE_CLOSE_PASS`，完成条件是 Runtime 返回 accepted 且 close receipt 可读。它不是 Git Boundary；该 receipt 会使 Stage 进入 archived，当前 `stage-close` Boundary 对已 archived Stage fail closed，因此两条入口不能被文档写成串行步骤，按当前 Contract 选择适用入口。
任一选定的 close 入口成功后，Brain 必须重新读取 Git HEAD/status、Manifest、Gate/Review/close receipts 与 `progress.md`，再重新计算 Stage/项目的下一动作；完成条件是新的持久化事实可重读，若走 Boundary 则其 Git commit 结果也可重读，不能以 Reviewer 摘要或 Boundary/CLI 投递成功替代。

## Runtime action 指针

每个循环只消费 Runtime 返回的一个 action：

- `DISPATCH_WORKER`：加载 `proofloop-worker` 与 `.agents/skills/proofloop-execute/references/worker-template.md`，使用固定的 `subagent` Host wrapper。
- `RUN_CV`：加载 `.agents/skills/proofloop-execute/references/code-verifier-template.md`，由 fresh CV 产生结构化结果。
- `ADMIT_WORKER_RESULT`、`ADMIT_CV_RESULT`、`ADMIT_SLICE_COMMIT`、`ADMIT_INTEGRATION`、`RUN_GATE`：调用对应 Runtime public CLI/consumer；Brain 不手写 Receipt、Manifest、Context、Gate 或 Review 状态。
- `PREPARE_STAGE_REVIEW`、`FINALIZE_STAGE_REVIEW`：按 Stage Review Contract 准备并调度 fresh Reviewer。
- `VALIDATE`：按 finding 的 `route_code` 路由，不绕过阻断。

精确 request 字段/closed schema 与 exit 语义以对应 Contract 和当前 Runtime 源码为准：`packages/runtime/src/cli/proofloop.ts` dispatcher、`proofloop-common.ts` 的 parser/closed-request validator、对应 domain handler 的校验；vNext 路由映射另看 `vnext-route-table.ts`。当前 public `--help` 仅输出全局 usage/domain 列表，不提供 operation-specific 字段/schema，因此不是 operation schema 或 exit-contract authority。Runtime-owned 制品、状态和 admission 不能由 Agent 总结补全。

## Worker transport 触发

Session 创建时固定 `subagent` transport，并使用 host-native Worker wrapper：
- Worker packet/result 必须遵守 `.agents/skills/proofloop-worker/SKILL.md` 与
  `.agents/skills/proofloop-execute/references/worker-template.md`。
- Agent `idle`/`done`、模型摘要和 Git diff 都不是完成证据；Brain 必须重读 durable facts 后再交给 Runtime。
- Host/adapter 缺少必需绑定时返回 typed `RUNTIME_BLOCKER`；已有成果按 `recover-task`/`recheck` 恢复，不重做 Task。
## 恢复与失效

| 事实 | 处理 |
|---|---|
| `PLAN_GAP` | 回 `.agents/skills/proofloop-plan/SKILL.md`，只修复 candidate/authority 计划闭环 |
| `IMPLEMENTATION_DEFECT` | 回 `.agents/skills/proofloop-execute/SKILL.md`，按 CV failure scope 派 Worker repair |
| `EVIDENCE_GAP` | 保留阻断，按 Runtime verification/recovery action 补齐事实 |
| `AUTHORITY_GAP` | 回对应 authority Skill；只使真实下游制品失效 |
| `TECHNICAL_UNKNOWN` | 路由 Researcher 或 Prototype；未验证前不修改 authority |
| `RUNTIME_BLOCKER` | 保留当前阶段和 resume target，修复环境/权限/工具后重新读取事实 |
| Worker Result 缺失、截断、重复或绑定不符 | fail closed；保留 diff/Evidence，按 lifecycle Contract recovery，不伪造 Result |
| Plan、Authority、Manifest、Context、scope 或 snapshot 改变 | 重新判断 currentness；需要时 fresh SPV/CV，不复用旧绑定 |

所有 upstream 修复后先识别实际下游 invalidation，再 REHYDRATE；不重开无关的已完成 Stage。除 `artifact-archive`（由 Brain 预执行精确 `git mv`）外，Git 写边界统一走 `.agents/contracts/brain/commit-boundary.md`；Brain/Agent 不直接执行其他 Git 写命令。

## Terminal

仅在以下条件之一成立时返回 Terminal：`PROJECT_ACCEPTED`；需要用户产品/authority 决定；存在已记录的 `BLOCKED`；或用户明确 `DEFERRED`。任何 `PLAN_READY`、`TASK_COMPLETE`、`READY_FOR_CV`、Gate PASS 或 Reviewer 叙事都不是项目终态。
