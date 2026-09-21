---
name: proofloop-execute
description: STAGE_EXECUTION：以 Vertical Slice Execution Lane 为自治单元，管理 dependency-ready Slice lane、Worker lifecycle、Slice-level CV、candidate Git ref、Integration 与 cleanup；Worker 执行 Brain running `proofloop-execute` 每个 Step 投影的 current Task 后返回 SLICE_CANDIDATE_READY，CV PASS 后先为 PASS_PENDING_CANDIDATE_REF，slice-output 建立 durable canonical candidate ref 后才 READY_TO_INTEGRATE，全部 Slice INTEGRATED 后 EXECUTION_READY_FOR_REVIEW；S06 integrity hard-freeze 时不得从 public Execute projection 继续运行，已闭合的 `MES_MAINTENANCE` branch 使用 evidence-only lane。
---

# proofloop-execute

本 Skill 是 Execute 的唯一方法来源：管理一个 Stage 的 Slice lanes，直到全部 planned Slice 集成完成。
本 Skill 是 Worker → Slice ready → CV → repair/recheck → PASS → candidate boundary（slice-output）→ Integration → cleanup 完整顺序的唯一方法 owner：`NORMAL` 下 pre-CV 的验证 target 是 live CV basis（Slice worktree branch/ref + 当前 HEAD + 当前 diff），`PRE_MES_BOOTSTRAP` 下仍是 candidate/accepted Git Plan ref + baseline/current Git basis；`MES_MAINTENANCE` 下使用 recovery candidate Plan + live maintenance worktree + frozen/forensic/audit binding，所有 Worker/CV/Integration/Review 产出为 evidence-only；durable canonical candidate ref（`proofloop-<stage>-<slice>`）只在最终 CV PASS 后的 slice-output 一次性建立。
Execute downstream basis 按 mode 固定：`NORMAL` 为 accepted Plan binding + bound normative refs + MES/Git/current code reality；`PRE_MES_BOOTSTRAP` 为 candidate/accepted Git Plan + bound normative refs + Git reality；`MES_MAINTENANCE` 为 recovery candidate Plan + current Technical Authority + Git reality + exact frozen/forensic/audit binding。
Execute 负责消费与校验 Planning 已关闭的 handoff，按 accepted Thin Plan 中的 planning facts（Stage/Slice/Task 目标、依赖关系、code anchors、verification refs、done/stop 条件与 bound normative refs）推进，不重新设计 Stage/Slice/Task 目标、依赖关系或 Project Stage Map；不根据 phase label、conversation history 或 Brain summary 重新构造 Authority set，具体 exact legality 以 canonical Contract（`tech-spec/contracts.md`）为准。
Execute 拥有 Slice Work Packet 与 per-Task JIT Read Set 的 projection 方法：Brain running `proofloop-execute` 每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、并只把该 Task 的 JIT input 投影给同一 Worker（`NORMAL` 将 accepted Thin Plan + MES/Git/current dependency outputs 投影为 execution inputs；bootstrap 从 Git/bound normative refs binding 投影；maintenance 从 recovery candidate + current Technical Authority/Git + frozen/forensic/audit binding 投影），不将 projection 职责回流给 Planner。
Worker 在 bounded execution scope（`code_paths`/`test_paths`）内根据 Plan + tech-spec + code reality 自己决定 HOW（具体实现方式、代码及测试变更）；Brain 提供 binding/refs/mutation boundary，不提供重写后的 semantic implementation instructions；Template（`references/worker-template.md`）与 Contracts Authority 定义 packet/schema，本 Skill 不复制 schema，也不向 packet 新增 Map 字段；Brain 负责路由、dispatch 与 semantic event 接纳，MES operational transaction layer 负责 NORMAL durable facts/relation materialization；`MES_MAINTENANCE` 的 Worker/CV/Integration/Review 只交付 Git/Link evidence，不写 MES。本 Skill 不调用任何旧 Runtime CLI，不写 Manifest/Receipt/Context/Gate，不把 Task 级 next-action 当作流程驱动。旧 Runtime/CLI 与 admission 链已被删除，本 Skill 不再依赖任何 legacy 控制链。

## Phase ownership
- **进入**：`NORMAL` 下 accepted Thin Plan 已就绪且 Stage 的 Slice lanes dependency-ready，且当前不存在 MES integrity hard-freeze；downstream basis 仅要求 accepted Plan binding + bound normative refs + current operational basis；`PRE_MES_BOOTSTRAP` 下仅首个 MES-persistence Stage 可由 Git-tracked Plan + bound normative refs/Git binding 进入；`MES_MAINTENANCE` 下仅在 recovery candidate Plan、current Technical Authority/Git、exact frozen/forensic/audit tuple、fresh SPV `PLAN_READY` 与 Brain bounded authorization 全部有效时进入。Execute 严格消费当前 mode 的已接纳 planning facts，不拥有 Stage/Slice/Task 分解或 Project Stage Map 编排。
- **完成**：`NORMAL` 下全部 planned Slice 或已 `INTEGRATED`、或由 Plan 声明为 `EXISTING_SEAM`-only 且 seam 已由 pre-accept SPV 复核，形成 `EXECUTION_READY_FOR_REVIEW`；`PRE_MES_BOOTSTRAP` 下首个 MES-persistence Stage 完成 MES persistence 集成并准备 seed 后关闭 bootstrap lane；`MES_MAINTENANCE` 下全部 maintenance Slice 的 Git candidate/integration/cleanup evidence 与独立 maintenance Review 闭合，仍不产生 MES 状态。Stage 整体验收交给 `stage-reviewer`，不由本 Skill 宣布。
- **回退**：CV finding / Integration failure 按本 Skill bounded repair 或回 Brain。Execute downstream 不直接 claim Product→Technical `AUTHORITY_GAP`：遇到 Plan 没覆盖 tech-spec obligation 时形成 `PLAN_GAP` 回退 Brain 路由 `proofloop-plan` 进行 Replan；遇到 tech-spec 自身冲突或证据不足返回 `TECHNICAL_UNKNOWN` / `EVIDENCE_GAP` / `RUNTIME_BLOCKER` 等实际 blocker，由 Brain 决定是否 route Planning 重新核对 Authority。不得由 Execute 或 Worker 自行修剪或重组 Plan。

## 加载链与事实源

1. 本 Skill：Stage loop、lane 管理、JIT projection 方法、分支与完成标准。
2. `.agents/skills/worker/SKILL.md`：Worker 执行被投影 current Task 的行为与 `SLICE_CANDIDATE_READY` 完成标准；Worker 在 bounded execution scope 内决定 HOW。
3. `.agents/skills/proofloop-execute/references/worker-template.md`：Slice Work Packet / per-Task JIT Read Set /
   bounded Repair Work Packet 的 packet/schema 单一来源（与 `tech-spec/contracts.md` 对齐，本 Skill 不复制 schema，不向 packet 新增 Map 字段）。
4. `.agents/skills/proofloop-execute/references/code-verifier-template.md`：Slice-level CV packet/schema。
5. `.agents/contracts/brain/agent-lifecycle.md`、`.agents/contracts/brain/commit-boundary.md`、`.agents/contracts/brain/integration.md`：
   lifecycle、Git boundary 与 Integration 机械事务语义（只引用，不定义）。

不要把完整 Thin Plan、Authority 或旧 packet 复制到 role；Execute 按当前 mode 拥有 JIT projection（`NORMAL` accepted Thin Plan + MES/Git/current dependency outputs；`PRE_MES_BOOTSTRAP` Git/bound normative refs；`MES_MAINTENANCE` recovery candidate + frozen/forensic/audit binding）→ Slice Work Packet 与 per-Task JIT Read Set，Worker/CV 通过 JIT Work Packet 与 bound normative refs fresh-read 各自输入。

## Slice Execution Lane 模型

Execute 以 Vertical Slice Execution Lane 为自治单元：

```text
Stage
├─ Slice A Lane
├─ Slice B Lane
└─ Slice C Lane
```

每 Slice：一个 Worker lifecycle、一个 isolated Git worktree、一个 Task graph、Slice-level CV；`NORMAL` 依赖 MES transaction layer materialized Task/Result facts，`PRE_MES_BOOTSTRAP` 仅依赖 Git + Git-tracked Plan + 结构化 Link evidence，`MES_MAINTENANCE` 仅依赖 recovery candidate + Git + frozen/forensic/audit evidence，三者不混用。one Slice = one Worker lifecycle = one isolated worktree = one Herdr tab。

Execute（Brain running `proofloop-execute`）按当前 mode 投影 Slice Work Packet，并在每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、只把该 Task 的 per-Task JIT Read Set 投影给同一 Worker：`NORMAL` 从 accepted Thin Plan + MES/Git/current dependency outputs 投影；`PRE_MES_BOOTSTRAP` 从 Git-tracked Plan + bound normative refs/Git facts 投影；`MES_MAINTENANCE` 从 recovery candidate + current Technical Authority/Git + frozen/forensic/audit binding 投影。Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body；每 Task fresh-read 当前 JIT Read Set / bound normative refs / code anchors / dependency outputs，并在 bounded execution scope（`code_paths`/`test_paths`）内根据 Plan + tech-spec + code reality 决定 HOW；Brain 提供 binding/refs/mutation boundary，不提供重写后的 semantic implementation instructions。`NORMAL` Task Result 由 MES transaction layer materialize，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` Task Result 是结构化 Link evidence，不读/写/声称 normal MES。Brain 对每个 Result 先按 schema/binding/Git basis 接纳并返回 closed `TASK_RESULT_ACK`；只有 `ACCEPTED` 后 Worker 才能继续，ACK 不携带 successor 指令。全部 Task 完成且 self-check 后，Worker 只形成 `SLICE_CANDIDATE_READY`，不声称 CV PASS 或 Integration。

- **`EXISTING_SEAM` obligation 不产生 lane**：`obligation_state: EXISTING_SEAM` 的 Task 只要求既有实现已满足该 obligation（`tech-spec/contracts.md` §4.1/§4.3）：不投影 Work Packet/per-Task JIT Read Set、不启动 Worker lane，也不产生任何 Work/Task/Result/Git completion facts。lane 只为真实可执行工作（`IMPLEMENTATION_MISSING`）创建，因此仅由该类 Task 组成的 Slice 同样不启动 lane；mixed Slice 的 `slice_task_ids` 只含需要执行的 Task，Plan 声明的 legitimate existing seam 在 Slice/Task dependency readiness 中按 satisfied predecessor 计（其 seam 由 pre-accept SPV 在 candidate Git basis 上复核，再由 Stage Review 针对 integrated snapshot 再证一次）。该 readiness 区分是 Brain/agent-level predicate，不由 `status` 或新增 public Slice state 表达。

## 有序执行循环

`NORMAL` / `PRE_MES_BOOTSTRAP` 按以下标准循环推进；`MES_MAINTENANCE` 使用紧随其后的 branch override，不能落入 NORMAL 步骤。
### MES_MAINTENANCE branch override（仅 S06 hard-freeze）
1. **REHYDRATE**：fresh-read recovery candidate Plan、current Technical Authority、Git/branch/worktree、frozen snapshot exact SHA/count、root-bound forensic/audit refs 与 physical quarantine；不读取 public status 作为 route，不要求 normal MES work identity。
2. **START**：Brain 仅在上述 tuple 与 fresh SPV `PLAN_READY`、dependency-ready Slice 和 bounded authorization 全部成立时创建 isolated maintenance worktree，并以 `execution_mode: MES_MAINTENANCE` 投影 packet；任一缺失返回 typed blocker。
3. **WORKER**：Worker 按 recovery candidate Plan 的 Task graph 执行 Brain running `proofloop-execute` 投影的 current Task；每个 Result/ACK 是 Git/Link evidence，Brain 接纳但不写 MES；Worker loss 从 Git/Plan/forensic/audit/frozen tuple fresh recovery。
4. **CV**：Slice-ready 后派发 fresh/read-only CV，绑定同一 maintenance candidate/live worktree 与 frozen/forensic/audit tuple；FINDINGS 只回 Brain 做 bounded repair/recheck，不写 MES。
5. **FREEZE/CANDIDATE**：CV PASS 后 Brain freeze producer writes、fresh-read diff，再经 `slice-output` 建立 durable Git candidate ref；不建立 MES candidate/state。
7. **MAINTENANCE REVIEW**：全部 maintenance Slice Git evidence 可重读后，使用 `stage-reviewer` 的 `review_scope: maintenance` / `execution_mode: MES_MAINTENANCE` 做三轴独立审查；PASS 仅是 evidence closure，不写 `STAGE_ACCEPTED`/`PROJECT_READY`。
8. **EXIT**：maintenance Review 通过后 Brain fresh-read 全部 evidence，才可按 recovery Contract 进入一次 controlled recovery transaction；transaction 后立即 re-quarantine、rehydrate/audit/restart，再决定 S06 impact。

1. **REHYDRATE**：`NORMAL` 读取 Git、accepted Thin Plan、既有 Task/Result facts、Findings 与 MES 事实；只有绑定 current accepted generation（该 (stage, `delivery_cycle_id`) 的 `plan_acceptance` chain 唯一 tip）的 downstream facts 视为 completion 支撑，绑定早前 generation 的 facts 保持 immutable/non-authorizing（`tech-spec/architecture.md#/entities/planning-acceptance-succession`）；`PRE_MES_BOOTSTRAP` 读取 Git + Git-tracked Plan + bound normative refs bindings，不读取/写入/声称 MES status 或 MES Task Result。Execute 消费 Plan planning facts，不重新设计 Stage/Slice/Task 目标或依赖。
   完成标准：当前 Stage/Slice 目标、依赖与待处理 finding 均可从持久化事实定位。
2. **确认 lane readiness**：确认 Slice 的 dependency outputs 就绪、worktree 与 Git basis 有效、required
   skills 明确。Slice readiness 仅要求 accepted Plan binding + bound normative refs + current operational basis。缺口返回 `PLAN_GAP` / `TECHNICAL_UNKNOWN` / `EVIDENCE_GAP` / `RUNTIME_BLOCKER`（不直接 claim Product→Technical `AUTHORITY_GAP`）。完成标准：可启动的 Worker lane 输入闭合。
3. **START Slice lane**：Execute 负责将 accepted Thin Plan + MES/Git/current dependency outputs（`PRE_MES_BOOTSTRAP` 为 Git-tracked Plan + bound normative refs/Git facts）投影为 Slice Work Packet（包含 Slice scope、`slice_task_ids`、依赖起点等输入；不新增 Map packet 字段），经 `worker` Role Skill 启动 lane。Brain 提供 binding/refs/mutation boundary，不提供重写后的 semantic implementation instructions；Worker 拥有当前 Task 的 HOW。Brain 启动 lane；lane 启动后每个 Step 的 current Task 选择与投影由 Brain running `proofloop-execute` 执行。完成标准：Worker 接管该 Slice 内部 Task loop 并返回绑定 lane 的首个结构化 Result/evidence；`NORMAL` Result 由 MES operational transaction layer materialize，bootstrap 不写 MES。
4. **逐 Step 选择与 JIT 投影**：Brain running `proofloop-execute` 每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、并只把该 Task 的 JIT input 投影给同一 Worker。每 Task 投影时，按 Execute 拥有的 JIT projection 将 accepted Thin Plan planning facts（Task goal、code anchors、verification refs、done/stop criteria、allowed scope）结合当前 MES/Git/dependency outputs 投影为 per-Task JIT Read Set；Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body，fresh-read 该 JIT Read Set 与 bound normative refs，在 bounded scope（`code_paths`/`test_paths`）内根据 Plan + tech-spec + code reality 自主决定 HOW 并完成实现，交付 `completed` Result；Brain 先校验 Result 并发起 semantic event，MES transaction layer materialize durable record，再返回同一 `resultId` 的 `TASK_RESULT_ACK`。只有 `ACCEPTED + CONTINUE` 后，Brain running `proofloop-execute` 才从稳定 task order 选择并投影下一 current Task 给同一 Worker。完成标准：Worker self-check 通过并返回 `SLICE_CANDIDATE_READY`。
5. **DISPATCH CV（live basis）**：Slice candidate ready 后 fresh-read Slice Goal + bound normative refs + Thin Plan +
   real code/tests/diff + live Slice worktree Git refs（worktree branch/ref + 当前 HEAD + 当前 diff），派发独立 Slice-level CV。
   `NORMAL` 的 pre-CV 验证 basis 是 live Slice worktree basis，不是 durable canonical candidate ref：`proofloop-<stage>-<slice>`
   在 CV 前尚未建立；`PRE_MES_BOOTSTRAP` 保持 candidate/accepted Git Plan ref + baseline/current Git basis + Worker Link evidence 的验证 basis。CV 不消费 Brain-projected Slice semantics，自读 Plan 与 tech-spec。完成标准：CV 返回 `PASS|FINDINGS|BLOCKED`。
6. **路由 CV 结果**：`FINDINGS` → 回 Brain 决定 owner/route，在**同一 Slice worktree** 上 bounded Worker repair →
   Result acceptance → 同一 CV continuation bounded recheck，直到 PASS 或 typed blocker；此阶段不建立 slice-output
   boundary、不建立 canonical candidate ref、不 Integration。`BLOCKED` → 结构化 blocker 回 Brain。`PASS` → 进入下一步，但此时 candidate 尚未 durable：`gateCvResult` 绑定 `candidateRefDurable=false`，状态为 `PASS_PENDING_CANDIDATE_REF`（never ready）。
   完成标准：CV 结果已被正确 consumer 接纳或已返回 typed blocker。
7. **FREEZE CANDIDATE（CV PASS 后）**：Brain 立即 freeze producer writes，fresh-read live basis（worktree HEAD、
   branch、git status、git diff、changed path set）并与刚被 CV 验证的 target/basis 核对；PASS 后若又发生 producer
   write，CV PASS 不再自动 current，不得继续 boundary，按现有 CV lifecycle 判断 bounded recheck 或 fresh CV。
   核对 current 后执行 `slice-output`：把最终 CV 已通过且仍 current 的 Slice worktree 内容机械固定为 candidate
   commit，建立/确认 durable canonical candidate ref（`proofloop-<stage>-<slice>`）；ref 已存在且指向其他 commit
   → fail closed 停止并返回 typed recovery blocker，不覆盖、不删除重建、不 direct-fix 搬运。
   slice-output 成功后 Brain fresh-read 并 exact 解析 canonical candidate ref（`proofloop-<stage>-<slice>`）→ commit SHA，且 candidate Git fact
   （ref / base / changed_files）与 slice-output 结果匹配；只有上述 freeze + slice-output 成功 + fresh-read exact
   canonical ref-to-commit 解析 + candidate Git fact 匹配全部成立后，Brain 才把 `candidateRefDurable` 置 true，
   状态进入 `READY_TO_INTEGRATE`；Brain 在 Worker/CV retain/close 决策处 fresh-read `.agents/contracts/brain/agent-lifecycle.md` 对应 matrix row。完成标准：durable canonical candidate ref 指向
   唯一 candidate commit，内容与 CV PASS 时一致。
8. **Integration**：`READY_TO_INTEGRATE`（CV `PASS` + durable canonical candidate ref current）后，Brain/Host 按
   `.agents/contracts/brain/integration.md` 定义的 `proofloop integration apply` 机械事务把该 candidate 集成进
   Stage 工作树（Brain 持有 ready/recovery 判断，Runtime 持有确定性 Git 事务；Integration 不是 `boundary close`
   的边界类型，不折叠进 `close`）。Integration 只消费 CV 实际通过的同一候选成果：candidate commit 内容 == CV PASS
   时的最终工作内容；不得再出现"CV 验证 repair diff 但 candidate commit 缺 repair → 先集成旧 candidate → 再
   direct-fix 重放 repair"。完成标准：集成成功形成 `INTEGRATED`；conflict/composition failure 形成 durable finding
   回 Brain，不直接回滚整个 Stage。仅纯机械且无语义选择的冲突可 bounded resolve。
9. **cleanup**：`INTEGRATED` → `CLEANUP_PENDING` → 清理 Slice worktree → `CLEANED`。cleanup failure
   不回退 `INTEGRATED`。完成标准：Slice worktree 清理完成，Slice 状态 `CLEANED`。
10. **RE-READ**：全部 planned Slice `INTEGRATED` 后，`NORMAL` 重新读取 Git 与 MES 事实；bootstrap 只读取 Git +
    Plan/evidence，形成 `EXECUTION_READY_FOR_REVIEW`。完成标准：全部 Slice 集成事实可复核。

## Worker 与 Slice loop

- `herdr-link` 是唯一跨 Agent/pane 的 Task/Result 通道，使用 `herdr_link_peers`/`herdr_link_send`/
  `herdr_link_close`；生命周期细则见 `.agents/contracts/brain/agent-lifecycle.md`。
- Planning 负责 WHAT / WHEN / BOUNDARY，Execute 拥有 JIT projection seam，Worker 在 bounded execution scope 内决定 HOW：
  - Execute 消费当前 mode 的 Thin Plan planning facts（NORMAL 为 accepted Plan；PRE_MES_BOOTSTRAP 为 Git-tracked Plan；MES_MAINTENANCE 为 recovery candidate），结合该 mode 允许的 MES/Git/dependency outputs 投影 Slice Work Packet 与 per-Task JIT Read Set；Execute 不重新设计 Stage/Slice/Task 结构，不修改 Project Stage Map，JIT projection 职责也不回流给 Planner。
  - Worker 在 bounded scope（`code_paths`、`test_paths`）内根据 Plan + tech-spec + code reality 决定具体的代码实现与测试构造（HOW）；Brain 提供 binding/refs/mutation boundary，不提供重写后的 semantic implementation instructions；Worker 不越界修改未授权路径。
  - Worker 的 authority refs 仅限 bound normative refs（Technical Authority）。
- Worker 执行被投影的 current Task：RED → 最小实现 → GREEN → Task Evidence → Task Result；`NORMAL` Task Result 作为 semantic event 经 MES transaction layer materialize，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 返回结构化 Link evidence（Git + Plan + 对应 binding），都不是 checkbox/凭证/next-action 完成。Task 边界：每个 Task 必须自足（local closure / verification closure / future-HOW independence），自然 TDD（RED → 最小实现 → GREEN）属同一 Task 的 HOW，不跨 Task 切碎。
- 全部 Task 完成后 Worker 返回 `SLICE_CANDIDATE_READY`；它不是 CV `PASS` 或 Slice Commit。
- Worker 每 Task 推进前 fresh-read 当前 binding（accepted/candidate Plan、bound normative refs、Slice scope、Git basis、dependency outputs），按 Slice packet 与 Thin Plan 由 Execute 投影的 JIT Read Set 执行；不跨 Slice、不从 scope 外选择或发明 Task。
- Brain 只负责 lane 启动与逐 Task Result 的 schema/binding/Git 复核、semantic-event authorization 及 `TASK_RESULT_ACK`；`NORMAL` 由 MES transaction layer materialize，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 重读 Git + Plan/evidence；ACK 不携带下一 Task 指令；下一 current Task 的选择与投影由 Brain running `proofloop-execute` 每个 Step 执行，Worker 返回 `SLICE_CANDIDATE_READY` 后才路由 CV。

## CV 与 bounded repair

- 初审是独立 initial，必须 fresh CV；Slice-level 反驳顺序与 verdict 字段以
  `references/code-verifier-template.md` 为准。CV 不消费 Brain-projected Slice semantics，自读当前 mode 的 Plan（NORMAL accepted；PRE_MES_BOOTSTRAP candidate/accepted Git Plan；MES_MAINTENANCE recovery candidate）、tech-spec、candidate/diff 与 code/tests；CV claimed route 不包含 `AUTHORITY_GAP`，下游问题分类限 `IMPLEMENTATION_DEFECT`、`PLAN_GAP`、`TECHNICAL_UNKNOWN`、`RUNTIME_BLOCKER`、`USER_DECISION_REQUIRED`、`EVIDENCE_GAP`。CV `FINDINGS` 后的 recheck 默认用同一 CV continuation 做 bounded incremental 复查（只覆盖 failed criterion、concrete counterexample、repair diff 与
  bounded incremental 复查（只覆盖 failed criterion、concrete counterexample、repair diff 与
  `required_recheck_scope`）；只有 target/basis 重大变化、session/identity 丢失、CV 写 artifact 或
  binding/Result 无法重读时才 fresh full initial。
- `NORMAL` 下 pre-CV 的验证 target 是 live Slice worktree basis（worktree branch/ref + 当前 HEAD + 当前 diff），不是 durable canonical `proofloop-<stage>-<slice>` candidate ref；该 canonical ref 只由 post-PASS `slice-output` 一次性建立。`PRE_MES_BOOTSTRAP` 使用 candidate/accepted Git Plan + baseline/current Git basis；`MES_MAINTENANCE` 使用 recovery candidate Plan + live maintenance worktree + frozen/forensic/audit binding，二者都不发明 PASS 前的 MES result/candidate store。
- 只有 `PASS` 进入 freeze → slice-output → Integration；`FINDINGS`/`BLOCKED` 回 Brain，不能直接 repair/replan。`NORMAL` downstream 由既有 MES disposition；`MES_MAINTENANCE` 保持 evidence-only。Finding 由 Brain 判定 disposition 与路由；Brain 派发 pointer-first repair packet 给 Worker，不要求 Brain 把 Reviewer 自然语言方案转写为 required_fix，Worker 拥有 repair HOW。
- 多轮 finding 的通用 family classification、history synthesis、`recheck_basis` 与停止规则由 `.agents/contracts/brain/finding-convergence.md` 管理；Worker/CV 的 repair packet、Result、history source 与 recheck 入口由 `.agents/contracts/brain/multi-round-repair.md` 管理。
  本 Skill 只执行当前 bounded failure scope。

## Verification execution discipline

Brain 在 Execute 中独立运行 build/typecheck/test 等验证时（含 CV repair 的独立复核）：

- verification entry 从当前 repository environment 取得：package.json scripts、package-level scripts、tsconfig references、
  test tsconfig、现有项目命令；环境是命令事实源，不从历史聊天、旧 session 或惯用命令猜构建入口。
- 不在本 Skill 写死具体 build 命令（如 `npx tsc ...`、`node --test ...`、`bun test ...`），除非该命令本身就是 Contract；
  实际命令每次 fresh-read 当前 repo scripts/config 获得，避免 Skill 成为 package.json / tsconfig 的 stale cache。
- 每一次 independent verification 结束后必须同时知道：实际执行的 command、真实 exit status、验证输出的位置、
  verification 前后 Git status 的变化。
- 展示管道不得掩盖被验证命令的 exit status：`command | tail` / `command | head` 截取日志时，不能把最后一个展示命令的
  退出结果冒充被验证命令的结果；保留真实 command exit status 或使用能保留 pipeline failure 的 shell 机制。完成条件
  是被验证命令本身成功，而不是日志打印成功。
- 验证产生新文件时先区分 expected configured outputs 与 unexpected source-tree / out-of-scope artifacts；只有后者
  是 verification hygiene 问题。正常 Worker diff 本身不是 dirty-worktree defect。

## Commit / Integration / cleanup

1. CV `PASS` 后 Brain 立即 freeze producer writes 并 fresh-read 当前 live worktree diff 与刚被验证的 target/basis 核对；经 `slice-output` 一次性建立 durable canonical candidate ref（`proofloop-<stage>-<slice>`），机械语义按 `.agents/contracts/brain/commit-boundary.md`；只处理当前
   Slice 的 committable scope，其他 Slice 的声明性 dirty worktree 按 Contract 容忍但不提交。
2. Integration 按 `.agents/contracts/brain/integration.md` 的 `proofloop integration apply` 机械事务执行（Brain/Host 把 candidate 集成进 Stage snapshot；机械语义只在该 Contract 定义，本 Skill 不复制发散规则）；失败分类为 pure mechanical /
   implementation / plan / authority / technical unknown，按分类回 bounded resolver / Execute repair /
   Planning / Propose / Research-Prototype。
3. `INTEGRATED` → `CLEANUP_PENDING` → `CLEANED`；cleanup failure 不回退 `INTEGRATED`。
4. `NORMAL` 下全部 planned Slice 或已 `INTEGRATED`、或由 Plan 声明为 `EXISTING_SEAM`-only 且 seam 已由 pre-accept SPV 复核 → `EXECUTION_READY_FOR_REVIEW`，随后交给 `stage-reviewer`；bootstrap 下先完成 MES persistence 集成并 seed，再恢复正常 Review 路径；`MES_MAINTENANCE` 不形成 `EXECUTION_READY_FOR_REVIEW`，全部 Slice 的 Git evidence/cleanup 后交给 maintenance Review branch。
5. `MES_MAINTENANCE` 下 `slice-output`/Integration/cleanup 仅建立与重读 Git/Plan evidence；不写 MES `INTEGRATED`/`CLEANED` 或任何 operational fact，完成后由 Brain fresh-read 并调度 evidence-only maintenance Review。

## 恢复与停止

- S06 integrity hard-freeze has precedence over the normal Stage lane: public `status` `EXECUTE`/`proofloop-execute` is observation only. Freeze NORMAL dispatch/continuation, preserve worktree and MES facts, and return a typed recovery/integrity blocker; only the Authority-defined `MES_MAINTENANCE` branch may proceed after its exact entry tuple is fresh-verified. Do not retry quarantine failures or resume from hidden session.
- Worker/Pane 丢失但已有 diff/Result facts：保留成果，按当前 mode 的 `recover-task`/`recheck`，不重新实现；`MES_MAINTENANCE` 仅从 recovery Plan、Git refs/commits、frozen digest/count 与 forensic/audit 重建。
- Result 缺失、截断、重复、错关联：返回 typed blocker，不接纳；该 Slice lane 暂停推进，由 Brain 决定 recover/fresh 路径，Worker 不跨过未接纳 Result 自动推进。
- `TASK_RESULT_ACK` 丢失/重复：NORMAL 由 Brain 从 MES 按原 `resultId` 幂等重发或接纳，PRE_MES_BOOTSTRAP / MES_MAINTENANCE 从 Git + Plan/evidence 与对应 recovery binding 重建；stale `actionToken` 或同 id 不同 payload fail closed，不得凭 Link `sent` 推进 successor。
- Plan continuation 三分类（`tech-spec/contracts.md` §2.2.4a）：`resume` 不写新 generation，继续使用 current accepted generation；`restart` 在 Planning tuple 未变时于同一 generation 下重开受影响 Slice 的 lane（Work identity 换新），上一 attempt 的 facts 只作历史、不足以支撑新 attempt 的 completion/Integration/Review；`replan` 走 `proofloop-plan` 的 Replan。三者都不生成新 `delivery_cycle_id`，都不 backfill 或改写历史 facts。
- Plan revision / Plan/Git tuple 变化（含 replan、SPV `FINDINGS` 修复）：必须针对新的 Plan/Git tuple 重新建立 fresh full SPV，
  完整重读新 tuple 并重新执行全部验证，不复用旧 verdict；不存在“非重大变化可复用 bounded SPV verdict”的规则。
- CV finding repair：review target/basis 未变时，按 code-verifier Contract 用同一 CV continuation 做 bounded recheck；
  仅 target/basis 重大变化、session/identity 丢失、CV 写 artifact 或 binding/Result 无法重读时才 fresh CV。
- Worker lane 的 scope/authority/snapshot 失效：仍按 currentness/Brain recovery 路由（`recover-task`/`recheck`），
  不能用 CV recheck 替代 SPV fresh，也不能用 bounded recheck 复用旧 SPV verdict。
- `PLAN_GAP` → `proofloop-plan`；`IMPLEMENTATION_DEFECT` → bounded Worker repair；`TECHNICAL_UNKNOWN` → Researcher/Prototype；`EVIDENCE_GAP` → 证据补全或重新核对；`RUNTIME_BLOCKER` → Brain/environment owner。Execute downstream 不直接 claim Product→Technical `AUTHORITY_GAP`：遇到 Plan 缺口返回 `PLAN_GAP`，遇到 tech-spec 自身冲突或证据不足返回 `TECHNICAL_UNKNOWN`/`EVIDENCE_GAP`/`RUNTIME_BLOCKER`，由 Brain 决定是否 route Planning 重新核对 Authority。
- 所有 blocker 保留 `route_code`、`subtype`、`reason`、`invalidation_scope` 与 `resume_target`；不把失败
  改写为完成。

## Pre-MES bootstrap 执行 lane（一次性例外）

`PRE_MES_BOOTSTRAP` 执行 lane 只对首个 MES-persistence Stage 合法：

- 只有该 Stage 可 pre-seed 运行；其他 Stage 一律不得 bootstrap，试图 bootstrap 其他 Stage 返回 blocker。
- Preflight 与 Task loop 使用 Git + Git-tracked Plan + Technical Authority bindings：Worker 按 bootstrap Task packet
  （见 worker-template 的 `execution_mode` 分支）实现，Task Result 是结构化 Link evidence，不读/写/声称 MES
  status 或 MES Task Result，不产生 Receipt/Manifest/Gate/第二状态机。
- lane 在 MES persistence 集成且 bootstrap facts 已 ready 时关闭，随后 seed accepted Plan/bootstrap facts 并切换
  到正常 accepted-Plan + MES transaction 路径；seed 后 `PRE_MES_BOOTSTRAP` 永久禁止，全部 NORMAL Result 经 transaction layer materialize，除非当前处于 Authority-defined integrity hard-freeze。
normal accepted-Plan + MES transaction path remains the normal path, but is unavailable while the S06 integrity hard-freeze is active.

## 硬边界

- `NORMAL` 只按 accepted Thin Plan、bound normative refs、JIT Work Packet 与 MES 事实驱动；`PRE_MES_BOOTSTRAP` 仅首个 MES-persistence Stage 按 Git-tracked Plan、bound normative refs、JIT Work Packet 与 Git facts 驱动；`MES_MAINTENANCE` 仅按 recovery candidate、bound normative refs、maintenance binding、JIT Work Packet 与 Git facts 驱动；不调用旧 Runtime CLI，不以旧 action 驱动流程。
- Execute 与 Worker 严格消费当前 mode 的 candidate/accepted Thin Plan planning facts，不重新设计 Stage/Slice/Task 目标、依赖图或 Project Stage Map；发现规划缺口（`PLAN_GAP`）统一回退 Brain 路由 `proofloop-plan` 进行 Replan。Execute downstream 与 Worker/CV 均不 claim Product→Technical `AUTHORITY_GAP`。
- JIT Work Packet 与 per-Task JIT Read Set 的 projection owner 保持 Execute，不回流 Planner，也不在 packet 中新增 Map 字段（Map 为 planning artifact；执行层按 mode 使用 accepted/candidate/recovery Plan 与允许的 MES/Git/evidence facts）。
- Worker 只能在 JIT Read Set / Thin Plan 授权的 bounded execution scope（`code_paths`、`test_paths`）内根据 Plan + tech-spec + code reality 自主决定 HOW，Brain 不提供重写后的 semantic implementation instructions；不得越界修改代码或测试，不得跨 Slice 发明 Task；`MES_MAINTENANCE` 还不得触碰真实 `.proofloop/mes`。
- Packet schema 单一事实源归 canonical worker template (`.agents/skills/proofloop-execute/references/worker-template.md`) 与 Contracts Authority (`tech-spec/contracts.md`)，本 Skill 不复制任何 packet schema。
- 不写旧 Runtime-owned 制品；Brain 是 semantic event authorization owner，MES transaction layer 是 NORMAL durable operational fact 的唯一写入者；bootstrap 与 integrity hard-freeze 的 `MES_MAINTENANCE` 阶段不写/不声称 normal MES。
- 业务完成条件只来自 Worker/CV/Integration 的结构化 Result/evidence 与对应模式的 durable facts；`MES_MAINTENANCE` 只允许 Git/Plan/forensic/audit evidence closure，不产生 normal operational completion。
