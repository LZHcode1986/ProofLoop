# Execute Flow Contract

- 位置：`.agents/contracts/brain/execute.md`
- 角色：Brain-owned **Execute Flow orchestration** 的唯一 canonical source。只描述 Brain 在 Execute Flow 内的 event → transition → dispatch / authorization（Slice lane、Worker lifecycle、CV dispatch、candidate publication、Integration 前置、cleanup、`EXECUTION_READY_FOR_REVIEW`）；**不包含 Worker 的 producer HOW**（RED / GREEN / implementation / test-construction 属于所选 Host 的 `worker` Role 文档）。
- 引用：Brain 按所选 Host Brain（`.pi/brain-workflow.md` / `.opencode/agents/brain.md`）的 Event-local fresh-read pointers 表进入本 Contract；本文件不复制 Host workflow body、Worker HOW 或 mechanical 事务正文。

## 1. 进入与退出

- **进入**：`NORMAL` 下 Brain 已完成 `PLAN_ACCEPTANCE`、accepted Plan binding current 且存在 dependency-ready Slice（`PLAN_READY` 仍为必要前置，但不构成完整 NORMAL Execute authorization）。
- **退出**：全部计划内 Slice 或已 `INTEGRATED`、或由 Plan 声明为 `EXISTING_SEAM`-only 且 seam 已由 pre-accept SPV 复核 → `EXECUTION_READY_FOR_REVIEW`，随后交给 `stage-reviewer`（Stage Review 由 `stage-review.md` / 所选 Host 的 `stage-reviewer` Role 文档拥有）。`MES_MAINTENANCE` 不形成 `EXECUTION_READY_FOR_REVIEW`。

## 2. Event → Transition

顶层只保留 event → branch pointer；只有当前 event 对应的 branch 进入 active context。

### 2.1 EXECUTE_ENTRY

- Brain 解析 dependency-ready Slice（accepted Plan binding + bound normative refs + current MES/Git/operational basis）；缺口返回 `PLAN_GAP` / `TECHNICAL_UNKNOWN` / `EVIDENCE_GAP` / `RUNTIME_BLOCKER`（不直接 claim Product→Technical `AUTHORITY_GAP`）。
- 确认 lane 输入闭合（dependency outputs 就绪、Git basis 有效、required skills 明确）后，经 public mechanical worktree seam 发起 closed `worktree create` request（`--json` / `--request <root-relative-json>`，必填 `stage` / `slice` / `base_ref`；CLI envelope schema 唯一属于 `.agents/contracts/brain/commit-boundary.md`，本文件不复制第二套格式）create / reuse Slice lane；Runtime 返回 canonical `relative_path`（`.proofloop/worktrees/<stage>-<slice>`），Brain 原样使用该 identity 作为 Worker cwd 并一路绑定 CV basis：启动所选 Host 的 `worker` Role 实例（`.pi/agents/worker.md` 或 `.opencode/agents/worker.md`，`cwd=<Runtime-returned relative_path>`，worker lifecycle 语义按 `agent-lifecycle.md`）。
- Brain 投影 Slice Work Packet（accepted Thin Plan + MES/Git/current dependency outputs → execution input）；由 Host 启动 Worker lane；Brain 提供 binding/refs/mutation boundary，不提供 rewrite 后的 semantic implementation instructions。
- 不变式：one Slice = one Worker lifecycle = one isolated worktree = one isolated execution lane。

### 2.2 WORKER_RESULT

- Worker 逐 Task fresh-read 当前 Projected JIT Read Set / bound normative refs / code anchors / dependency outputs，在 bounded execution scope（`code_paths`/`test_paths`）内决定 HOW 并实现；`NORMAL` Task Result 作为 semantic event 经 MES transaction layer materialize，`MES_MAINTENANCE` 返回结构化 Subagent transport evidence。
- Brain 校验 Result binding/schema/Git basis 后返回 closed `TASK_RESULT_ACK`（`ACCEPTED|REJECTED` × `CONTINUE|PAUSE`）。
- Task Result acceptance 按共享 Result interface 校验：Brain 只按 `worker/references/worker-template.md` 的 Result envelope schema（`outcome`/`changedFiles`/`verificationRuns`/`actionToken`/`resultId` 等闭集字段）与 `tech-spec/contracts.md` §4.3 barrier 校验 attachment 与证据字段，不加载所选 Host 的 `worker` Role 文档方法正文决定接纳；producer-proof 的产生语义（如何跑通 verification seam、如何记录证据）由两个 Host 的 `worker.md` 文档持有，本 Contract 只按 interface validation 接纳。
- `ACCEPTED + CONTINUE` 后，Brain 按 Execute Flow Contract 从稳定 task order 选择下一 dependency-ready Task 并只把该 Task 的 JIT input 投影给同一 Worker；ACK 不携带 successor 指令；Worker 不自行选择 successor、不接收 future Task body。

### 2.3 SLICE_CANDIDATE_READY

- Worker 全部 Task 完成且 self-check 后只形成 `SLICE_CANDIDATE_READY`；它不是 CV `PASS` 或 Slice Commit。
- **本 event 的 Brain transition 只能进入 CV dispatch**（S05-D/F regression）。Brain fresh-read Slice Goal + bound normative refs + Thin Plan + real code/tests/diff + live Slice worktree Git refs（worktree branch/ref + 当前 HEAD + 当前 diff），dispatch 独立 Slice-level CV：启动所选 Host 的 `code-verifier` Role 实例（`.pi/agents/code-verifier.md` 或 `.opencode/agents/code-verifier.md`）。
- `NORMAL` 的 pre-CV 验证 basis 是 live Slice worktree basis，不是 durable canonical candidate ref（`proofloop-<stage>-<slice>` 在 CV 前尚未建立）。
- **在此 event 不得**：执行 downstream candidate publication、Integration 或 cleanup；这些动作不属于 Worker，也不在 `SLICE_CANDIDATE_READY` 分支展开。

### 2.4 CV_FINDINGS

- CV 输出 `FINDINGS` / `BLOCKED` 一律回 Brain；raw finding 只是 evidence，不是 Worker 指令。
- Brain 重读 Authority / Plan / scope / code reality 后产生 `FINDING_DISPOSITION`（语义按 `finding-convergence.md` / `mes.md`）。
- 有效 Finding：选择 bounded repair owner（Worker / CV lane 按 lifecycle / currentness 判定），在**同一 Slice worktree** 上 bounded Worker repair → Result acceptance → 同一 CV continuation bounded recheck，直到 PASS 或 typed blocker。`VERIFIER_OVERREACH` 不自动 route repair。
- 仅 target/basis 重大变化、session/identity 丢失、CV 写 artifact 或 binding/Result 无法重读时才 fresh full CV。
- 此阶段（FINDINGS / repair / recheck 未 final PASS）**不得**建立 slice-output boundary、不得建立 canonical candidate ref、不得 Integration。
- 多轮 finding 的 family classification / history synthesis / `recheck_basis` / 停止规则由 `.agents/contracts/brain/finding-convergence.md` 与 `.agents/contracts/brain/multi-round-repair.md` 管理。

### 2.5 CV_PASS（仅 final current CV PASS 后）

- **Canonical candidate publication 只在 final current CV PASS 后由 Execute Flow Contract 授权**（S05-D/F regression）：pre-CV、CV `FINDINGS`、bounded repair、CV recheck（final PASS 前）都不属于 publication 时机。
- Brain 立即 freeze producer writes，fresh-read live basis（worktree HEAD、branch、git status、git diff、changed path set）并与刚被 CV 验证的 target/basis 核对；PASS 后若又发生 producer write，CV PASS 不再自动 current，按 CV lifecycle 判断 bounded recheck 或 fresh CV。
- 核对 current 后经 `slice-output` 把最终 CV 已通过且仍 current 的 Slice worktree 内容机械固定为 candidate commit，建立/确认 durable canonical candidate ref（`proofloop-<stage>-<slice>`）；机械语义按 `.agents/contracts/brain/commit-boundary.md`。该 boundary 使用同一 current lane identity 作为 `expected_worktree`：live CV basis.worktree → final PASS freeze basis → boundary `expected_worktree` 必须是同一 lane identity，candidate freeze 时不得临时换 worktree。ref 已存在且指向其他 commit → fail closed 返回 typed recovery blocker，不覆盖、不删除重建。
- slice-output 成功后 Brain fresh-read 并 exact 解析 canonical candidate ref → commit SHA，且 candidate Git fact（ref / base / changed_files）与 slice-output 结果匹配；全部成立后 `candidateRefDurable=true`，状态进入 `READY_TO_INTEGRATE`。
- Worker/CV retain/close 决策处 fresh-read `.agents/contracts/brain/agent-lifecycle.md` 对应 matrix row。

### 2.6 READY_TO_INTEGRATE

- `READY_TO_INTEGRATE`（CV `PASS` + durable canonical candidate ref current）后，Brain/Host 按 `.agents/contracts/brain/integration.md` 定义的 `proofloop integration apply` 机械事务把 candidate 集成进 Stage 工作树（Integration 不是 `boundary close` 的边界类型，不折叠进 `close`）。
- Integration 只消费 CV 实际通过的同一候选成果：candidate commit 内容 == CV PASS 时的最终工作内容；不得"CV 验证 repair diff 但 candidate commit 缺 repair → 先集成旧 candidate → 再 direct-fix 重放 repair"。

### 2.7 INTEGRATED / ALL_SLICES_INTEGRATED

- Integration 成功 → `INTEGRATED`；conflict/composition failure 形成 durable finding 回 Brain，不直接回滚整个 Stage；仅纯机械且无语义选择的冲突可 bounded resolve。
- `INTEGRATED` → `CLEANUP_PENDING` → Brain 经 public mechanical worktree seam 发起 closed `worktree remove` request（`--json` / `--request <root-relative-json>`，必填 `stage` / `slice`；CLI envelope schema 唯一属于 `.agents/contracts/brain/commit-boundary.md`）清理 Slice worktree（Runtime clean-only remove + postcondition）→ `CLEANED`；cleanup failure 不回退 `INTEGRATED`。
- 全部 planned Slices `INTEGRATED`（或 `EXISTING_SEAM`-only 且 seam 已由 pre-accept SPV 复核）→ Brain 重新读取 Git 与 MES facts → `EXECUTION_READY_FOR_REVIEW`。

## 3. MES_MAINTENANCE branch override（仅 S06 hard-freeze）

- integrity hard-freeze 优先于 normal Stage lane：public `status` `EXECUTE` projection 只是 observation；freeze NORMAL dispatch/continuation，保留 worktree 与 MES facts，返回 typed recovery/integrity blocker。
- 该 branch 只有在 exact entry tuple（recovery candidate Plan + current Technical Authority + Git/branch/worktree + frozen snapshot exact SHA/count + root-bound forensic/audit refs + physical quarantine + Brain bounded authorization）全部 fresh 有效时进入。
- Worker/CV/Integration/Review 由 packet 的 `execution_mode: MES_MAINTENANCE` 与 `cwd` 指向 isolated maintenance worktree/evidence root；只交付 Git/Subagent transport evidence，不写 MES；`slice-output`/Integration/cleanup 仅建立与重读 Git/Plan evidence。
- 全部 maintenance Slice Git evidence 可重读后由 `stage-reviewer` `review_scope: maintenance` 做三轴审查（PASS 仅是 evidence closure，不写 `STAGE_ACCEPTED`/`PROJECT_READY`）；通过后 Brain 才可按 recovery Contract 进入一次 controlled recovery transaction，transaction 后立即 re-quarantine、rehydrate/audit/restart。
- 该 branch 不新增 fallback、不降级 NORMAL、不复活 `PRE_MES_BOOTSTRAP`。

## 4. Context pointers（本 Flow 内事件所需的唯一 owner）

| WHEN | READ |
|---|---|
| `EXECUTE_ENTRY` / lane 启动 | 本文件 §2.1；`agent-lifecycle.md`（dispatch / lifecycle）；`mes.md`（accepted Plan binding current） |
| `WORKER_RESULT` / ACK | 本文件 §2.2；`mes.md`（NORMAL materialization）；`worker/references/worker-template.md`（Result envelope schema / ACK 闭集，interface owner）；`tech-spec/contracts.md` §4.3（acceptance barrier） |
| `SLICE_CANDIDATE_READY` | 本文件 §2.3（CV 是唯一合法 transition）；`stage-review.md` 不适用；CV schema 读 `code-verifier/references/code-verifier-template.md` |
| CV `FINDINGS` / repair / recheck | 本文件 §2.4；`finding-convergence.md`；`multi-round-repair.md`；`agent-lifecycle.md` |
| `CV_PASS` / candidate publication | 本文件 §2.5；`commit-boundary.md`（slice-output / canonical candidate ref） |
| `READY_TO_INTEGRATE` / Integration | 本文件 §2.6；`integration.md` |
| `INTEGRATED` / cleanup | 本文件 §2.7；`agent-lifecycle.md`；`mes.md` |

Worker 的 producer method 唯一 owner 是两个 Host 的 `worker.md` 文档（`.pi/agents/worker.md` / `.opencode/agents/worker.md`）；Result envelope / ACK schema 的 interface owner 是 `worker/references/worker-template.md` 与 `tech-spec/contracts.md` §4.3；本 Contract 只按 interface validation 接纳 Result，不复制 RED / GREEN / implementation / test-construction HOW，也不通过加载 Worker Role 文档获得这些 method。

## 5. 硬边界

- 本 Contract 只拥有 Execute Flow orchestration（event → transition → dispatch / authorization）；不承担 Producer 职责，不复制 Worker HOW。
- **S05-D/F 顺序**：`SLICE_CANDIDATE_READY` → CV dispatch 唯一；canonical candidate publication 仅 final current CV PASS 后授权；pre-CV / FINDINGS / repair / recheck 阶段都不发生 publication。
- Execute 与 Worker 严格消费当前 mode 的 candidate/accepted Thin Plan planning facts，不重新设计 Stage/Slice/Task 目标、依赖图或 Project Stage Map；发现 `PLAN_GAP` 统一回退 Brain 路由 Planning Flow 进行 Replan；Execute downstream 不 claim Product→Technical `AUTHORITY_GAP`。
- JIT Work Packet 与 per-Task JIT Read Set 的 projection owner 保持 Execute Flow Contract，不回流给 Planner，也不新增 Map packet 字段。
- 不调用旧 Runtime CLI、不写旧 Runtime-owned 制品；Brain 是 semantic event authorization owner，MES transaction layer 是 NORMAL durable operational fact 的唯一写入者。
- NORMAL Slice worktree create/list/remove 只经 public mechanical worktree seam（`proofloop worktree create|list|remove`）执行；Brain 拥有何时调用与传哪一个 current lane identity（`stage` / `slice` / `base_ref`），Runtime 返回的 `relative_path`（`.proofloop/worktrees/<stage>-<slice>`）原样用于 Worker cwd → CV live basis.worktree → final PASS fresh-read basis → boundary `expected_worktree` → cleanup remove。NORMAL Brain 不自行运行 raw `git worktree add/remove/prune`、不自行拼接 `.pi/...` 或其它 worktree path；Worker/CV 不获得 worktree create/remove ownership。same-repo Git 验证算法、path canonicalization、CLI schema 与 boundary type table 属于 `.agents/contracts/brain/commit-boundary.md`，本文件不复制。