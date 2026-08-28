---
name: proofloop-execute
description: STAGE_EXECUTION：admitted Manifest 和 Runtime Primary Next Action 就绪时，按 Worker/CV/Commit/Integration/Gate/Review 顺序推进；在 Result 缺失、绑定失效、CV repair 或运行阻塞时按持久化事实恢复。
---

# proofloop-execute

本 Skill 负责 admitted Stage 的有序 Delivery Loop。Contract 定义语义、字段和状态；Role Agent 定义
角色判断；Template 定义 packet/schema；Runtime 是 Context、admission、Receipt 和状态的唯一权威。

## Phase ownership

- **进入**：Stage Plan admission Receipt 已存在，Manifest/Plan/Proof Index/Context/snapshot 绑定有效，
  Manifest 声明的 Slice Evidence paths 可用，Runtime 入口门禁通过。
- **完成**：所有 Slice 已集成，Runtime 已持久化 Stage Gate `PASS`；之后进入 Stage Review，不能由本
  Skill 自行宣布完成。
- **回退**：Stage Review `REPAIR`、Gate `FAIL` 或 Worker/CV finding 按本 Skill bounded repair；Plan/
  Authority 变化回 `proofloop-plan` 或相应 Authority Skill。

## 加载链与事实源

1. 本 Skill：Stage loop、action 路由、分支和完成标准；
2. `.agents/skills/proofloop-worker/SKILL.md`：通用 Worker 行为、Evidence 顺序和 transport Result；
3. `references/worker-template.md`：Worker packet/schema；`references/herdr-worker-template.md`：
   `transport: herdr-link` 的 Host relay；
4. `references/code-verifier-template.md`：CV packet/schema；
5. `.agents/contracts/brain/herdr-link-worker-lifecycle.md`、`.agents/contracts/brain/commit-boundary.md`
   和 Brain dispatch 指定的 Stage Review Contract：生命周期与 boundary 语义。

不要把完整 `tasks.md`、Authority 或旧 packet 复制到 role；Runtime 返回的 `context_ref`、digest 和
immutable scope 才是当前 action 的输入。

## 入口门禁

派发或推进前重新核对：

- Stage Plan admission、Manifest digest、Plan/Proof Index、Authority/SPV 和 snapshot tuple；
- 每个 Slice 的 Manifest-declared Evidence path、当前 Worker/CV/Commit/Integration receipts；
- public `proofloop stage next` 返回唯一 `Primary Next Action`、owner、actionToken 和 Context input/ref；vNext 该调用只读，不持久化 Context；需要持久化时由 Brain/Host 调用 `proofloop context prepare` 并在 dispatch 前校验 Context；Worker 直接消费 supplied Context；CV 仅在未闭合 Evidence gate 的既定顺序内调用允许的 `context admit-refutation-observation`/`context show` seam；其他 Runtime admission 仍由 Brain 调用；
- `implement-task`/`recover-task` 的非空 root-bound code/test `execution_scope`、forbidden scope、
  `plan_projection_path` 和 mutable projection；其他 mode 使用其 taskless/evidence/bounded-failure 规则；
- canonical Trust Root、Stage branch、当前 Git HEAD，以及未解决的 error-level Findings。

缺 admission、绑定、Context 或必需 scope 时返回 `RUNTIME_BLOCKER`/`EVIDENCE_GAP`；不得补写 packet、
猜路径或以 Validator/SPV 结果直接执行。

## 单周期控制循环

每次只推进一个 Runtime action：

1. **REHYDRATE**：读取 Git、Manifest、Plan、Context、Evidence、Receipts、Findings 和 Runtime state。
2. **NEXT**：调用 public `proofloop stage next`；vNext 该调用只读并不持久化 Context，核对 action、owner、digest、Context input/ref 与持久化事实。
3. **DISPATCH**：加载 action 对应的 Role/Skill/Template，只执行当前 action，不选择未来 Task。
4. **RETURN**：接收一个结构化结果；把它交给正确的 Runtime admission/Boundary consumer。
5. **RE-READ**：重新读取 durable facts 和 Git，再计算下一 action。

完成标准：本周期的结果已被正确 consumer 接纳并留下 receipt/state，或已返回带完整 route envelope 的
bounded blocker；`idle`、`done`、模型摘要、checkbox 或 `result_available` 不算完成。

## Context handoff
`proofloop stage next` 只返回当前 Primary Next Action 及其 Context input/ref，不负责写 Context。若当前 action 需要持久化 Context，Brain 另调用 `proofloop context prepare`；当前 handler 的 Worker projection 走 `persistVNextWorkerContext`，其他闭集 role 走 `persistVNextRoleContext`。
Brain/Host 在 dispatch 前负责准备并用对应 role/ref 读回、校验 supplied Context；Worker 不调用 Runtime CLI，直接消费 supplied Context。CV 不走通用 Context handoff，仅在未闭合 Evidence gate 的既定顺序内调用允许的 Context seam。
CV Evidence gate 的真实 owner/order 是：Brain/Host 以已验证 task anchor 调用 `context prepare --role cv --stage <stage-id> --slice <slice-id> --task <task-id>`，并在 dispatch 前校验 CV Context；CV 在尚未读取 Evidence 时调用允许的 CV-only `context admit-refutation-observation --role cv --stage <stage-id> --slice <slice-id> --task <task-id> --observation <text>`，再以 `context show --ref <pre-refutation-context-ref> --observation-ref <observation-ref>` 验证 `gate.satisfied: true`。CV 只在该 gate 顺序内调用 `context admit-refutation-observation`/`context show`；其他 Runtime admission 仍由 Brain 调用。
当前 `RUN_CV` output 不提供 `task_id`、CV Context ref 或 `worker_receipt_digest`；packet 必须由 Brain 显式提供并绑定当前 Worker chain tip，CV 不得猜测。closed `CV_RESULT` 不承载 task/observation handoff，且 `stage admit-cv`/`admitVNextCVResult` 不消费 gate；因此当前 route 未闭合，缺少可验证 handoff 时 CV 必须在读取 Evidence 前返回非 admission `BLOCKED`，由 Brain 路由为既有 `RUNTIME_BLOCKER`，不得声称 PASS 或把 direct fixture 当作 gate coverage。

## Action 路由

| Runtime action | 处理入口 | 完成条件 |
|---|---|---|
| `DISPATCH_WORKER` | `proofloop-worker` + `worker-template`；`herdr-link` route 另加 `herdr-worker-template` | 绑定当前 action 的完整 Worker Result 已发送并被 `stage admit-worker` 接纳 |
| `RUN_CV` | `code-verifier-template`，fresh CV；先满足可证明的 Evidence gate | 当前 handoff 缺失时只返回非 admission `BLOCKED`/既有 `RUNTIME_BLOCKER`；只有真实 Context/observation handoff 与 Runtime consumer 闭合后，`PASS`/`REPAIR` 才能进入 CV admission |
| `ADMIT_WORKER_RESULT` | Runtime Worker admission | Runtime 从 durable facts 计算下一个合法 Task 或 `RUN_CV` |
| `ADMIT_CV_RESULT` | Runtime CV admission | `PASS` 进入 Slice Commit；`REPAIR` 进入 bounded repair/recheck |
| `ADMIT_SLICE_COMMIT` | `.agents/contracts/brain/commit-boundary.md` + Runtime admission | commit tuple 被接纳并产生 Slice Commit Receipt |
| `ADMIT_INTEGRATION` | Runtime/Git integration consumer | 当前 Slice 集成 Receipt 与 snapshot 绑定 |
| `RUN_GATE` | Runtime Stage Gate consumer | facts-only Gate `PASS`/`FAIL` Receipt 持久化 |
| `PREPARE_STAGE_REVIEW` / `FINALIZE_STAGE_REVIEW` | Stage Review Contract + fresh Reviewer | prepared fact/Review Result 被正确 consumer 接纳 |
| `VALIDATE` | Brain 按 finding `route_code` | 形成 typed recovery 或回到唯一可执行 action |

精确 CLI request、exit code 和 closed schema 只读取对应 Contract 与当前 CLI 源码；涉及 Stage composition route 时还要核对
`packages/runtime/src/cli/vnext-route-table.ts`。当前 public `--help` 仅返回全局 usage/domain 列表，不提供 operation-specific 字段或
closed schema，不作为 operation contract 的权威来源；Brain 不手写
Receipt、Manifest、Context、Gate 或 Review 状态。

## Worker 与 Slice loop

- Worker 每次只接收 Runtime 指定的一个 Task 及 admitted immutable `execution_scope`；同一 Session 的
  transport 在创建时固定。`herdr-link` 是唯一跨 Agent/pane Task/Result 通道，使用
  `herdr_link_peers`/`herdr_link_send`/`herdr_link_close`；`subagent` 仅是显式同 harness 兼容路线，
  不是隐式切换。生命周期细则见 lifecycle Contract。
- `implement-task` 顺序由 `proofloop-worker` Skill 负责：RED → 最小实现 → GREEN → Task Evidence →
  checkbox → `TASK_COMPLETE`；Evidence 先于 checkbox。
- 所有 Task 完成后才派 `finalize-slice`，由 Worker 更新当前 Slice Evidence 并返回 `READY_FOR_CV`；
  它不是 CV `PASS` 或 Slice Commit。
- Brain 收到 Result 后先重读 Evidence、tasks projection、Git/diff、Context 和 Receipts，再交给 Runtime；
  不用 Link delivery 状态或模型叙事补全。

## CV 与 bounded repair

- Initial/recheck 均使用 fresh CV；独立反驳顺序、Evidence 延迟读取和 verdict 字段以
  `references/code-verifier-template.md` 为准。
- 只有 `PASS`/`REPAIR` 进入 Runtime CV admission；其他 verdict 按 `route_code` 路由。Contract、Goal、
  PO、Seam、Authority、Manifest、Plan、Context、scope 或 snapshot 变化时重新 initial CV。
- CV `REPAIR` 后由 Runtime 返回 taskless `DISPATCH_WORKER mode=repair`，绑定当前
  `repairs_cv_receipt_digest`；Worker 返回 `mode='repair'` 的交接 envelope，不进入普通 `stage admit-worker`，
  由 `stage next` 校验后置 `PENDING_RECHECK` 并触发 fresh bounded recheck。
- 第二轮 repair/diagnose 的 history、root-cause 和下一轮路由由 `.agents/contracts/brain/multi-round-repair.md`
  管理；本 Skill 只执行当前 bounded failure scope。

## Commit、Integration、Gate 与 Review

1. CV `PASS` 后，Brain 按 Boundary Contract 调用 public Boundary CLI；只处理当前 Slice 的 committable
   scope，并将其他 Slice 的声明性 dirty worktree 按 Contract 容忍但不提交。
2. Runtime 接纳 Slice Commit 后，执行 vNext Integration；任何 commit/receipt/snapshot mismatch 都 fail closed。
3. Stage Gate 是 facts-only 的 Runtime consumer：默认验证每个 Slice 的 Integration Receipt chain；仅在
   Runtime Contract 明确的 `verification_source: git_facts` 路径下使用 Git facts。Gate 不执行 optional Manifest
   `runtime_proof`；不绑定新的 `runtime_proof_digest`；build/test 与 goal challenge 由 Stage Review 承担。
4. Gate `PASS` 后，按 `.agents/contracts/brain/stage-review.md` 先准备事实，再 dispatch fresh Stage Reviewer；Reviewer `ACCEPTED` 经 `review finalize-stage` Runtime admission 持久化后，才进入 normal full close。
5. Normal full close 走 `.agents/contracts/brain/commit-boundary.md`：Brain 调用 public `proofloop boundary close`，请求的 `boundary_type` 为 `stage-close`；Boundary 在 Git 写入前复核 Gate/Review、集成 HEAD 和 Manifest-declared Evidence，成功返回 `commit_sha` 才算 Git boundary 完成。
6. `proofloop stage close` 是另一条 P-11 Runtime close-fact admission 入口；选定该 full/restricted 路由时，`admitVNextStageClose` 写入 `STAGE_CLOSE_PASS`，accepted 且 close receipt 可读才算完成。它不是 Git boundary；该 receipt 会归档 Stage，当前 `stage-close` Boundary 对已归档 Stage fail closed，因此两条入口不可写成串行步骤。
7. 选定的 close 入口完成后，重新读取 Git、Manifest、Gate/Review/close Receipts 和 progress，再计算下一 action。

每个边界都必须验证前序 Receipt digest、Manifest/Plan/Context/snapshot tuple 和 changed-file scope；
progress、projection 和 Agent narrative 只能帮助恢复。

## 恢复与停止

- Worker/Pane 丢失但已有 diff、Evidence 或 projection：保留成果，按 `recover-task`/`recheck`，不重新实现。
- Result 缺失、截断、重复、错 action、错 digest 或错回复关联：返回 `WORKER_RESULT_MISSING`/typed blocker，
  不接纳、不派发下一个 action。
- Plan/Authority/Manifest/Context/scope/snapshot 变化：重新判断 currentness，按需 fresh SPV/CV；不使用旧 receipt 补全。
- `PLAN_GAP` → `proofloop-plan`；`IMPLEMENTATION_DEFECT` → bounded Worker repair；`EVIDENCE_GAP` → Runtime
  verification；`AUTHORITY_GAP` → authority Skill；`TECHNICAL_UNKNOWN` → Researcher/Prototype；
  `RUNTIME_BLOCKER` → Brain/environment owner/User。
- 所有 blocker 保留 `route_code`、`subtype`、`reason`、`invalidation_scope` 和 `resume_target`；不将失败改写为 PASS。

## Runtime CLI 指针与硬边界

Brain 是唯一调用 canonical public Runtime admission/Boundary CLI 的角色；CV 仅可在 Evidence gate 顺序中调用 CV-only Context gate operations，不得调用其他 Runtime admission。

```text
node packages/runtime/dist/cli/proofloop.js
```

Worker、CV、Reviewer 不调用 Runtime admission、不写 Runtime-owned 制品、不创建 Git boundary；所有结果必须
经当前 vNext consumer 接纳。除非 Runtime 明确返回并接纳下一 action，本 Skill 不自行循环、猜测 owner 或宣布
Stage complete。
