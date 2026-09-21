# Process Discipline Matrix — ProofLoop 新流程模型

> 本矩阵把新流程模型的"问题 → 防复发机制 → 权威落点 → 复核方式"固定下来。它不定义新的
> Runtime 状态或治理机制，不复制 Authority / Skill / Contract 长正文，也不保留旧流程整改
> 的历史编号。
>
> 权责分离：Host Agent 文档固定 Brain/Role 步骤、分支、权限和 transport；Contract 固定语义、字段、状态和错误；Template 固定 packet/result schema；Brain 负责 route/dispatch/recovery；MES 保存 operational facts（不做 reasoning）；Runtime/Kernel 提供机械 CLI（`boundary close`、`integration apply`）、MES snapshot/seed、fact/binding validation、只读 status observation seam 与安全原语；Host/Subagent host 只负责 Agent/session/process 与 transport。

## 1. Discipline matrix

| ID | Risk/problem | Prevention mechanism | Authority location | Verification | Status |
|---|---|---|---|---|---|
| PD-001 | MES 重新变成 state machine | MES 只保存 operational facts / status；Brain + Skill 做 reasoning；MES 不输出 next action、不判断 Repair/Replan、不复制 Skill workflow | `.agents/contracts/brain/mes.md`; `tech-spec/contracts.md` §2 | status fixtures：正常/异常/restart；输出扫描无 next action | confirmed |
| PD-002 | 旧 Receipt/Gate 与新 MES 双权威 | 旧业务控制语义整体退役；每个业务域只有一个 cutover 点；旧 API 不作为 fallback；不建 compatibility layer | `PRD.md` FR-012; `tech-spec/architecture.md` ADR-001/008 | source scan：无 active 旧 business-control 引用（历史段显式标记 legacy） | confirmed |
| PD-003 | Brain 依赖旧 Runtime 推导下一动作 | 所选 Host Brain 文档依据 Routing Boundary、durable facts 和当前 Contract routing；status 只作 observation，不消费旧 Primary Next Action | `tech-spec/architecture.md` FR-004/§4（control-plane）；`.opencode/agents/brain.md`；`.pi/brain-workflow.md` | control-plane / 静态 loop-token 检查 | confirmed |
| PD-004 | 整本计划指纹导致局部返工连坐 | Slice-level proof binding 三层 fingerprinting（Stage 全局契约 + per-Slice 契约 + 执行绑定）；Task-local / Slice-wide Replan 分类 | `PRD.md` FR-013; `tech-spec/contracts.md` §5.1 | FR-013 Case 1-9 fixtures | confirmed |
| PD-005 | CV PASS 被当成完成 | CV PASS ≠ INTEGRATED；Integration 是独立步骤；cleanup failure 不回退 INTEGRATED | `tech-spec/architecture.md` §6（Execute）; `tech-spec/contracts.md` §5.3 | Execute fixtures：CV PASS 后仍 READY_TO_INTEGRATE；INTEGRATED 才记录 | confirmed |
| PD-006 | verifier finding 被当成 producer 指令 | verifier finding（SPV / CV / Stage Reviewer）一律先回 Brain；raw finding 只是 evidence；Brain 写 `FINDING_DISPOSITION` 后才按 `accepted_route_code` route；verifier 全程 read-only，不向 Worker/Planner 直接发 producer instruction，不能直接修复 | `PRD.md` FR-004; `tech-spec/architecture.md` §6; Host Role documents / MES Contract | finding→Brain arbitration fixtures；SPV/verifier read-only & no-producer-instruction scan；无直接 route | confirmed |
| PD-007 | 三轴 Review 互相掩盖 | 每轴独立输出 `PASS | FINDINGS | BLOCKED` + evidence；no masking；不 generic score averaging | `tech-spec/architecture.md` §6（Review）; `stage-reviewer` Skill | Review fixtures：Outcome PASS + Composition FINDING 不得 ACCEPTED | confirmed |
| PD-008 | Recovery 依赖凭证链/隐藏会话 | 恢复输入 = MES durable state + Planner/SPV candidate 或 Execute/Worker/CV/Review accepted Plan + Authority + structured Results/Findings + Git/worktree reality；不恢复旧 Primary Next Action / credential 链 / hidden conversation | `PRD.md` FR-009; `tech-spec/contracts.md` §5.2 | Agent loss / Brain restart fixtures | confirmed |
| PD-009 | 按旧 Subagent type/session / `idle` 错误 continuation | continuation 必须重读 Stage/Slice/Task/Prototype binding、Planner/SPV candidate 或 Execute/Worker/CV/Review accepted Plan、Git snapshot 和 identity；无法证明则 recovery/fresh | lifecycle Contract; `tech-spec/contracts.md` §5.2 | E2E：binding changed negative fixture；无 `idle`/`done` 续接 | confirmed |
| PD-010 | Reviewer 在 finding 仲裁前失去独立性 | Reviewer 初审独立进行；verifier/reviewer finding 一律先回 Brain 经 Brain arbitration（`FINDING_DISPOSITION`）；Reviewer 全程 read-only；repair 后仅在 basis current 时 same Reviewer bounded recheck | `.agents/contracts/brain/agent-lifecycle.md`; Host Reviewer document; `tech-spec/contracts.md` §5.2 | review-loop fixtures；artifact diff audit | confirmed |
| PD-011 | 下游把 CONTEXT/Working Material 当 Authority | CONTEXT 降为 Working Memory；四类 canonical Authority 是唯一决策来源；Thin Plan 只放小粒度 Authority refs | `PRD.md` FR-002; `tech-spec/contracts.md` §6 | Authority refs fixtures；无第二份正文 | confirmed |
| PD-012 | 删除旧代码时误删安全能力 | 机械原语（path/process/Git-worktree/protected-scope/ID-schema/replan-impact）先抽取再删业务 wrapper；删除前重新做 import graph | `PRD.md` FR-011; `tech-spec/architecture.md` ADR-008 | mechanical primitive fixtures；import graph 复查 | confirmed |
| PD-013 | Runtime 实现状态漂移被当成事实 | Authority 不跟踪 mutable implementation progress；runtime capability claims 必须与验证事实一致；Operational delivery state 属于 MES/Git facts，进度投射到 progress.md / CONTEXT.md 且二者不是 downstream Authority（governance 见 `tech-spec/contracts.md` §6.0） | `tech-spec/contracts.md` §6.0; `tech-spec/acceptance.md` STATIC-10; `PRD.md` FR-003 | source scan：canonical Authority 无 implementation progress；contracts.md 存在 separation invariant | confirmed |
| PD-014 | Verifier 被 operational state 污染 | verifier packet 提供 target/basis/evidence；MES status 只作最小阶段/Skill 提醒，不作为 PASS/FINDING 证据 | `tech-spec/contracts.md` §2.4; `stage-plan-verifier`/`code-verifier`/`stage-reviewer` Skills | verifier basis fixtures | confirmed |
| PD-015 | 并行 Slice 一个 blocked 阻断全部 | MES 二级状态按 Slice 记录 blocked_by；一级只显示稀疏异常；无依赖 Slice 继续 | `tech-spec/contracts.md` §2.4/§5.1 | parallel state fixtures | confirmed |
| PD-016 | 权限/取消失败被吞掉或扩大权限 | 每个 Host Agent/Subagent transport 边界保留原始诊断和 typed blocker；取消协作式传播；不扩大 permission、不写 protected path | `AGENTS.md`; `.agents/contracts/brain/agent-lifecycle.md`; Host Agent documents; Runtime boundary | denied/cancel/protected-path fixtures | confirmed |
| PD-017 | evidence 无绑定或靠 narrative 完成 | Task Result 写入 MES 必须携带可重读绑定（stage/slice/task、accepted Plan ref、Git basis、Result/Finding ref），并先通过 Brain `TASK_RESULT_ACK`；`sent`/`idle`/`done`、checkbox、模型摘要不构成完成依据 | `PRD.md` FR-014; `tech-spec/contracts.md` §2.2/§4.3 | Result binding + ACK negative fixtures | confirmed |
| PD-018 | replan 静默沿用受影响结果 | Task-local / Slice-wide 分类；受影响结果显式失效并重新规划/执行；不得静默沿用 | `PRD.md` FR-013 Case 8/9; replan-impact 原语 | FR-013 fixtures | confirmed |
| PD-019 | Project Stage Map 与 MES operational state 双写或由非 Planner 角色修改 | Project Stage Map（`delivery/project-stage-map.md`）是 Git-tracked execution-owned planning artifact，唯一 writer 是 Planner（`proofloop-plan` MAP CHECK；Map-absent 由 Planner 首次创建，General/Brain/MES 不代写）；Map 只保存 Stage id / depends_on / goal / entry criteria / Authority refs，不缓存 operational readiness；`ready / blocked / executing / accepted` 等实时状态由 MES/Git facts 表达，两处不双写 | `PRD.md` FR-003/005; `tech-spec/architecture.md` ADR-013/§4/§6; `tech-spec/contracts.md` §4.0/§6.0; `tech-spec/acceptance.md` STATIC-21/STATIC-22 | `delivery/project-stage-map.md` writer scan（Planner only）；Map artifact scan 无 mutable readiness；MES schema scan 无 Stage graph / Map-specific fact kind；STATIC-21/STATIC-22 checks | confirmed |
| PD-020 | Brain dispatch 泄漏 Planning method 或自行做 Stage/Slice decomposition | 两个 Host Brain 文档只传 route facts/binding 与 mutation boundary，不传 generic Planning instructions；Planner Agent 文档负责 Planning method，Brain 不做 Stage/Slice/Task decomposition | `PRD.md` FR-004/005; `tech-spec/architecture.md` §4/§6; Host Planner documents; `tech-spec/acceptance.md` STATIC-23/STATIC-24 | dispatch packet scan 无 method/candidate_scope/instructions；Planning launch fixtures | confirmed |
| PD-021 | SPV 越权直接修复 Plan、修改代码或向 Planner 发送 producer instruction | SPV Agent 文档规定只读反驳顺序与 `PLAN_READY | FINDINGS | BLOCKED`；finding 先回 Brain arbitration，Plan 修复由 Brain 重新派发 Planner/SPV | `PRD.md` FR-004/005; `tech-spec/architecture.md` §6; Host SPV documents; `.agents/skills/proofloop-plan/references/stage-plan-verifier-template.md` | SPV read-only scan；finding arbitration fixtures | confirmed |
| PD-022 | Planning 与 Execute 权责倒置 | Planner Agent 文档只产出 WHAT/WHEN/BOUNDARY；`proofloop-execute` 拥有 JIT Work Packet projection；Worker Agent 文档只在 bounded scope 决定 HOW，不接收 future Task | `PRD.md` FR-005/006; `tech-spec/architecture.md` §3/§6; Host Planner/Worker documents; `tech-spec/acceptance.md` STATIC-25 | Thin Plan/JIT projection/Worker scope fixtures | confirmed |
| PD-023 | 历史归档 `.docs` 渗入当前流程决策或破坏 canonical Authority 唯一性 | 归档文档（包括 `.docs/` 内的历史方案与旧实施计划）不作为 active design source，不参与 current decisions；四类 canonical Authority（`PRD.md`、`tech-spec/architecture.md`、`tech-spec/contracts.md`、`tech-spec/acceptance.md`）与 active Contract / Skill 是唯一决策来源；历史 `.docs` 引用仅允许出现在 Historical/legacy 标记段或 negative fixtures，不得作为流程前置、规则依据或运行时凭证 | `PRD.md` §1/FR-002; `tech-spec/contracts.md` §6.0/§6; `tech-spec/acceptance.md` STATIC-11/STATIC-26; `AGENTS.md` §3 | active source scan：无未标记 legacy 的 `.docs` 依赖引用；STATIC-11/STATIC-26 checks | confirmed |
| PD-024 | Host config 被误当作 MES/Plan/Result business truth，或出现第二配置源 / 宽泛 ignore | Host Agent config 是 versioned project config：Pi `.pi/agents/*.md` + `.pi/subagents.json`，OpenCode `.opencode/agents/*.md`；这些路径必须 Git tracked、not ignored、clean checkout 可提供，正常修改会产生 Git diff。Host config diff 不属于 MES operational currentness、不成为 Plan/Result/Review business fact、不自动授权 route；`role_skill == subagent_type` 不变；缺失/非法 config fail closed 为既有 typed `RUNTIME_BLOCKER`，无默认值猜测 / fallback / retry / quota detection / model routing / Profile-Pool-alias-mapping layer | `PRD.md` FR-010; `tech-spec/architecture.md` ADR-007/§4/§5/§6; `tech-spec/contracts.md` §5.4/§6; `tech-spec/acceptance.md` STATIC-07/STATIC-09 | `git ls-files` 必须命中 Host config；`git check-ignore` 必须不命中；tracked config 的普通 diff 与 `.pi/mcp.json` tolerance 分离；missing/invalid config fail-closed fixture；STATIC-07/STATIC-09 checks | confirmed |

## 2. Authority placement rules

- Product goal、用户行为和范围只在 `PRD.md`。
- Architecture boundary、module owner、flow 和 ADR 只在 `tech-spec/architecture.md`。
- API/file/schema/state/error 和 owner 只在 `tech-spec/contracts.md` 与对应 Contract。
- Hard Part、forbidden shortcut、minimum implementation 和 residual risk 只在 `tech-spec/architecture.md` 的 Hard Parts and Risk Register。
- Requirement → Architecture/Contract → Acceptance traceability、E2E、静态检查只在
  `tech-spec/acceptance.md`。
- Process discipline 只在本矩阵建立风险索引，不复制上述长正文。
- Host Agent 文档（Pi `.pi/agents/*.md`；OpenCode `.opencode/agents/*.md`）分别定义 Brain/Role 工作规范；两侧独立加载且保持 `role_skill == subagent_type`。Host config 是 versioned native dispatch config，不是 MES/Plan/Result currentness 输入；缺失/非法 → typed `RUNTIME_BLOCKER`，无 fallback/retry/第二业务 workflow source。
- MES durable facts 与 Git facts 不由任何文档或 Agent narrative 伪造。
- `delivery/project-stage-map.md` 是 Git-tracked execution-owned planning artifact，唯一 writer 是 Planner（`proofloop-plan` MAP CHECK），readers 为 Brain / Planner / SPV / Execute（按需只读）；Map 不缓存 operational readiness，MES 不双写 Stage 计划拓扑。
- Brain 是唯一 cross-phase route / dispatch / recovery owner，dispatch 只传 current target / facts / refs / binding 与 mutation boundary，不携带 Planning method/decomposition；Planning method 由所选 Host Planner Agent 文档分别内嵌且语义同步；Execute 拥有 JIT Work Packet projection 方法，Worker 在 bounded execution scope 决定 HOW。
- SPV 是只读 Stage 计划反向验证者，finding 经 Brain 仲裁，不直接修复 Plan、不向 Planner 发送 producer instruction。
- 归档 `.docs`（含历史方案与实施计划）不参与 current decisions，不作为 active design source；四类 canonical Authority、active Contracts、phase references 和 Host Agent 文档是当前决策来源。

## 3. Review checklist

在每个 Worker/CV/Reviewer 或 Host 改动完成后，按以下顺序复核：

1. 当前流程动作是否来自 MES status 指定的 Skill + canonical facts / Result / Finding / Git？
2. 所选 Host Agent 文档、Contract 和 Template 是否各自只承担一种职责？Role 工作流程是否已内嵌到 Pi/OpenCode 对应 Agent，Host config 是否保持 versioned native schema 且与业务 boundary 分离？
3. 业务 Result 是否带有可重读的 Stage/Slice/Task/Plan/Git binding？
4. 是否把 Subagent type、agent_id、session_id、transcript、message id、`sent`/`idle`/`done` 或 dialogue 当成完成
   依据？如是，必须退回。
5. Subagent host/Host/permission/cancel 失败是否 typed blocker、no-write 且无 fallback/retry？
6. Reviewer 是否先独立初审且全程 read-only？三轴是否独立、no masking？repair 后的复查
   是否仍绑定当前 basis？
7. Agent/Brain 重启是否从 MES + Git + Result/Finding 恢复，而不是恢复隐藏对话或旧凭证链？
8. OpenCode `.opencode/agents/brain.md` 与 Pi `.pi/brain-workflow.md` 是否各自包含一份完整 Brain workflow？是否没有第三份 workflow/controller、reasoning-loop 或每轮 reread 强制指令？
9. MES 是否只保存 operational facts，不输出 next action、不判断 Repair/Replan？
10. 本改动对应的 E2E/Static evidence 是否已经记录在 tracked acceptance artifact？
11. Project Stage Map 是否仅由 Planner（`proofloop-plan` MAP CHECK）维护？Map 是否未缓存 operational readiness（`ready / blocked / executing / accepted`），MES 是否未与 Map 双写计划状态？
12. Brain dispatch 是否只携带 route facts/binding 与 mutation boundary，未向 Planner 携带 Planning method、`candidate_scope` 或 Stage/Slice 分解？
13. SPV 是否全程 read-only，SPV finding 是否回 Brain 仲裁而不是直接修复或向 Planner 发 producer instruction？
14. Planning（WHAT/WHEN/BOUNDARY）与 Execute（JIT projection/HOW seam）权责是否分明？JIT Work Packet projection 是否由 Execute 拥有，Worker 是否在 bounded scope 决定 HOW？
15. 是否没有把归档 `.docs` 当成 active 决策来源，canonical Authority/Contract/Skill 是否保持单一事实源？

## 4. Prevention-to-acceptance map

| Discipline | Primary acceptance |
|---|---|
| PD-001/002/003/013 | status fixtures；source scan；control-plane / 静态 loop-token 检查 |
| PD-004/018 | FR-013 Case 1-9 fixtures |
| PD-005/015 | Execute / parallel state fixtures |
| PD-006/010/014/021 | review-loop fixtures；verifier basis fixtures；SPV read-only / no-producer-instruction scan |
| PD-007 | Review no-masking fixtures |
| PD-008/009 | Agent loss / Brain restart fixtures |
| PD-011/023 | Authority refs fixtures；STATIC-11/STATIC-26 scan；`.docs` 引用审计 |
| PD-012 | mechanical primitive fixtures；import graph 复查 |
| PD-016 | denied/cancel/protected-path fixtures |
| PD-017 | Result binding negative fixtures |
| PD-019 | STATIC-21/STATIC-22 fixtures；Map writer/readiness scan；MES schema scan |
| PD-020 | STATIC-23/STATIC-24 fixtures；Brain dispatch packet scan |
| PD-022 | STATIC-25 fixtures；Thin Plan schema scan；Execute projection ownership scan |
| PD-024 | STATIC-07/STATIC-09 fixtures；`git ls-files`/`git check-ignore` tracked/not-ignored assertions；tracked Host config ordinary diff isolation；missing-config fail-closed 检查 |

## Discipline completeness

- [x] 每个新流程风险都有独立纪律机制。
- [x] 每个机制有唯一权威落点和复核路径。
- [x] Contract/Skill/Template/Brain/MES/Host 职责边界明确。
- [x] Fallback、retry、metadata authority、review independence、MES 双权威和 durable
  recovery 均有负向检查。
- [x] E2E 与 Static acceptance 指向 tracked 制品。
- [x] Project Stage Map、Brain dispatch、SPV read-only、Planning vs Execute 分工与归档 `.docs` 边界具备可检查纪律。