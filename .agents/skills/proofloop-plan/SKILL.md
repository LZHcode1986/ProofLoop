---
name: proofloop-plan
description: STAGE_PLANNING 阶段技能：ProofLoop active planning 指导：调用 `plan materialize` 生成或更新 candidate tasks.md、调度 stage-plan-verifier（SPV）、处理 PLAN_GAP 或 SPV finding、重启后恢复 planning 时使用。
---

# proofloop-plan

## Phase ownership

- 阶段：STAGE_PLANNING（Brain + `proofloop-plan` + Runtime）
- 进入条件：Stage Goal 与 Work Items 已选定（STAGE_GOAL_SELECTED）；Authority 就绪
- 完成信号：candidate Plan/Evidence 最终 Git boundary、Validator PASS、fresh SPV `PLAN_READY`，随后 Runtime Stage Plan admission
- 交接：admitted Manifest 交给 `proofloop-execute`（STAGE_EXECUTION）；阶段切换由 Runtime admission 驱动
- 回退：用户要求修改计划时，Brain 重新加载本技能；Authority 变更则回到对应权威阶段技能

本 Skill 是 Brain 的 active planning 方法。

## 加载与调用

加载本 Skill 后，Brain 通过 Runtime public CLI 调用 `plan materialize` 完成
Plan materialization；确切 operation/request 语法以
`references/plan-materializer-contract.md` 和当前 CLI `--help` 为准。命令契约
（确定性渲染；可选 `"check": true` 只读复核，不产生写入）和写入边界（candidate
`delivery/stages/<stage-id>/tasks.md`，必要时同源 `candidate-input.json` 瞬态输入）
见该 Contract。

`plan materialize` 是 Runtime CLI 的确定性命令，无独立 agent owner，是 candidate
Plan 的唯一写入者。

candidate tasks.md 的唯一写入动作是 `plan materialize` 命令（确定性渲染，Brain
不手写）；不能以叙事、手写隐式步骤或直接编辑替代该命令。

## 职责

Brain 负责：

- 选择 dependency-ready 的 Architecture Work Items（AWI）；
- 判断是否满足 Authority Readiness；
- 调用本 Skill；
- 调用 `plan materialize` 并消费其结构化返回（CANDIDATE_READY / CANDIDATE_CHECKED）；
- 接收结构化结果并进行全局路由。

本 Skill 负责：

- 读取稳定的 AWI/entity refs 和 Authority refs；
- 通过 `plan materialize` 生成或更新 candidate `tasks.md`；
- 建立 Stage/Slice/Task、Proof Index、Dependencies 和 Required Skills 的引用闭环；
- 准备 vNext SPV 的最小输入。

Runtime 负责：

- 编译 candidate Manifest；
- Mechanical Validator；
- Evidence skeleton 初始化；
- Stage Plan admission、Receipt 和执行授权。

本 Skill 不判断 Stage 完成。

## 输入

Brain 调用 `plan materialize` 时提供最小且闭合的结构化输入；完整 schema 和
不变式见 `references/plan-materializer-contract.md` 的必需输入 / 输入不变式，
调用前必须逐条对照。Brain 不复制完整 PRD、Tech Spec、
Hard Parts 或旧 Stage Packet；`plan materialize` 只消费计划结构和稳定引用。

所有输入字段、禁止字段、scope/proof/ref 不变式、`binding_mode` 和输出边界均以
`references/plan-materializer-contract.md` 为唯一事实源；调用前逐条加载并核对该
Contract，Skill 不重复其底层 schema。

Brain 仍必须在构造输入前完成代码级 scope 核查：Task 的结构化
`execution_scope` 只能来自 Authority/Contract 的明确事实，不能从 goal、Markdown
或代码搜索推断；`plan materialize` 只保留和验证 caller 已声明的 scope。

## 调度与返回

Brain 每次为一个 Stage 调用一次 `plan materialize`，并把整个结构化输入作为该次
调用的语义输入。成功 envelope（`CANDIDATE_READY | CANDIDATE_CHECKED` 的完整
字段定义；`CANDIDATE_CHECKED` 是只读 `--check` 复核结果，不产生写入）和
失败时的结构化 route envelope（`route_code`/`subtype`/`reason`/
`affected_artifacts`/`suggested_owner`/`invalidation_scope`/`resume_target`）均以
contract 的输出契约 / 返回与路由 为准；失败或需要上游
判断时，不能返回"看起来成功"的 Markdown。

`CANDIDATE_READY` 只表示 candidate source 已落盘；它不表示 Validator、SPV、
Manifest、Evidence 或 admission 成功。

## 规划循环

1. Rehydrate Git、Authority、已有 candidate Plan、candidate input、Manifest、Findings 和进度快照。
2. 确认 selected AWI 的依赖已经满足，相关 Hard Parts 已 `VALIDATED` 或有明确延期决策。
3. 生成最小 Stage/Slice/Task 结构化输入；不从 Authority 正文发明事实。构造 Task 的
   `execution_scope` 前必须先做代码级数据流核查：读关键模块代码/数据流，确认
   `code_paths`/`test_paths` 内路径可达且与实现一致；不得仅从目标文本推断 scope。
   核查完成标准：每个声明的路径都能在代码中定位到实际文件或符号，scope 与实现
   一致后才调用 `plan materialize`。
4. 为每个 Stage/Slice/Task 保留稳定 entity refs、Dependencies 和 Required Skills。
5. 建立 `goal_ref`、`task_refs`、`acceptance_refs`、`seam_refs`、`oracle_refs` 和 `risk_refs`。
6. 调用 `plan materialize`，只生成或更新 candidate `tasks.md`。
7. 重新读取 candidate Plan 和同源 candidate input，确认没有由 progress 或 Agent
   narrative 补全的事实。`plan materialize` 仍只写 candidate Plan/input。
8. 调用 Runtime 编译 candidate Manifest 并执行 Mechanical Validator；Validator PASS 前
   不初始化 Evidence，不建立最终 Stage Plan boundary。
9. Validator PASS 后，Runtime 根据 Manifest 声明 exclusive-create Evidence skeleton，
   且必须在最终稳定 Git boundary 前完成；`plan materialize` 和 Brain 均不得手写或覆盖
   非空 Evidence，initializer 对非空文件 fail closed/skip 的具体行为由 Runtime
   Contract 决定。
10. 重新读取 candidate Plan、candidate input、Manifest 和全部 Evidence skeleton，确认
    digest/ref 绑定一致后，由 Committer 建立最终稳定 Git boundary：canonical project root
    必须是 clean worktree。Git 的正常 `.gitignore` 规则继续生效，允许被忽略的
    `.proofloop` Runtime artifacts；tracked 或未被忽略的 untracked 文件都必须先处理。
11. 读取最终 boundary 的当前 Git HEAD 和已编译绑定，使用
    `references/stage-plan-verifier-template.md` 新建 fresh SPV dispatch；SPV 必须先运行
    template 声明的 `active-spv-boundary-check.mjs`，机械确认 clean Git boundary、HEAD 和
    canonical digest，不能用 Brain narrative 代替。
12. 修复 Plan 缺陷（SPV/CV finding）时必须联动检查：权威文件边界、验收定义、Evidence
    绑定；发现上游不一致时同步更新（AGENTS.md「修改上游事实后，必须识别并报告受影响的
    下游制品」的具体化），修复后重新编译 Manifest、重跑 Validator，并按需 fresh SPV；
    不得用局部 patch 掩盖上游事实不一致。
13. SPV `PLAN_READY` 后，Brain 才能调用 Runtime Stage Plan admission；admission 必须
    再次确认 snapshot=HEAD 且 worktree clean。
14. admission 成功后，调用 `proofloop_stage(next)` 生成唯一 next/context，再进入
    `proofloop-execute` 派发 Worker。

## Candidate Plan boundary

`tasks.md` 与同源 `candidate-input.json` 是 admission 前的 candidate projection，
不能授权执行，也不是第二事实源。允许内容是最小 Stage/Slice/Task 结构、稳定 refs、
Dependencies、Required Skills 和明确的 `execution_scope`。

`references/plan-materializer-contract.md` 是 candidate schema、entity markers、Proof
Index、immutable/mutable projection、candidate-only/out_of_scope、禁止输入/输出和
`plan materialize → Runtime` handoff 的唯一事实源；所有结构校验必须加载该 Contract。
本 Skill 只保留规划判断和顺序，不复制底层字段、产品、架构、Hard Part 或 Runtime command
正文。

## plan materialize → Runtime 交接

`plan materialize` 只渲染 candidate Plan 或执行只读 check；compile、validate、Evidence、
最终 Git boundary、fresh SPV、Stage Plan admission、next/context 和执行 dispatch
属于后续 Runtime/Skill owners。`CANDIDATE_READY`、Validator PASS 和 `PLAN_READY`
都不单独授权执行；按 Contract 与规划循环步骤 8–14 继续交接。

## Admission 后 Replan 纪律

- Stage 已 admission 后禁止重跑 `plan materialize`：该命令按输入确定性渲染整个
  candidate tasks.md，重跑会重置已受理任务的 checkbox/Worker Status 投影。
- 确需 replan：必须保留或恢复已受理 Slice 的投影（checkbox/Worker Status 从 HEAD 恢复，只改目标任务区），或遵循 Runtime 的 recover/re-admission 流程（归档 receipts → 重受理）。禁止静默重置。
- 新模式（slice-local）：已受理 Slice 状态由 Receipt 推导（currentness 经
  binding-currentness 判定）；投影重置不影响 currentness——replan 后已受理 Slice
  状态不丢。

## SPV 调度

SPV packet、验证顺序、digest 提取和结果路由以
`references/stage-plan-verifier-template.md` 为准。调度前必须完成最终 Plan/Evidence
stable Git boundary，canonical worktree clean，且 `snapshot_digest` 绑定当前 HEAD；
Plan、Authority、Manifest binding 或 snapshot 变化时 fresh dispatch，未变化时不得重复
SPV。progress、checkbox projection 和 Agent narrative 不构成 authority。

## Gap 路由

Gap subtype、route envelope 和 owner 由 `references/plan-materializer-contract.md`
与 Brain Global Route Router 共同定义；非成功结果必须保留
`route_code`、`subtype`、`reason`、`suggested_owner`、`invalidation_scope` 和
`resume_target`，不得以 Markdown 成功叙述替代结构化 finding。

## 恢复与失效

- Skill 上下文丢失或 `plan materialize` 输出需要重跑时（仅限 admission 前），从
  Git、Authority、candidate Plan、同源瞬态输入、Manifest、SPV Findings 和 progress
  snapshot 重新运行；admission 前 `replan` 必须重新调用 `plan materialize`；Stage 已
  admission 后的 replan 纪律见「Admission 后 Replan 纪律」。
- Plan Goal、Proof Index、Acceptance/Oracle/Seam/Risk ref 或 Dependencies 变化时，使相关 candidate Manifest、Evidence 和验证结果失效。
- 纯 checkbox/status 变化不使 immutable Plan 或 Authority Context 失效。
- SPV_PASS 后的复用与 fresh 规则见 SPV 调度段。
- 不因一个 Stage Plan 变化而重开无关的已完成 Stage。

`plan materialize` 返回后，Brain 必须重新读取持久化事实。旧 candidate 不存在、输入
digest 不一致、entity marker 缺失/重复、ref kind 不匹配或 output path 越界时，
停止并返回结构化 finding；不得从 session memory、Agent narrative、checkbox
或 progress snapshot 补全。

## 重启与验证

用户重启后，至少验证以下事实：

1. `plan materialize` 命令可用（`node packages/runtime/dist/cli/proofloop.js plan
   materialize --help` 返回用法）；
2. Brain 加载 `.agents/skills/proofloop-plan/SKILL.md` 后能定位
   `references/plan-materializer-contract.md`；
3. `plan materialize` 的最小 fixture 只产生 candidate `tasks.md`（以及显式提供的
   同源瞬态输入），不产生 Manifest、Evidence、Receipt 或执行 dispatch。

仓库内可重复执行的验证命令：

```text
npm exec -- vitest run test/proofloop-plan-process-consistency.spec.ts
node packages/runtime/dist/cli/proofloop.js plan materialize --help
```

验证必须以文件和结构化输出为事实；重启本身不能替代上述 fixture test。

## Runtime CLI pointer

Planning steps use the single public Runtime CLI entry:
`node packages/runtime/dist/cli/proofloop.js`。具体 domain/operation、closed request
schema、exit code 和 root/path 约束由当前 CLI `--help` 与对应 Runtime Contract 提供；
本 Skill 不缓存命令参数表。

## 禁止事项

- 不启动正式 Stage；
- 不派发 Worker/CV/Committer；
- 不执行 `proofloop_stage(next)`；
- `plan materialize` 不生成/更新 Manifest、Evidence、Receipt 或 Runtime State；
- 不写 Stage Plan admission、SPV、Task、CV、Gate 或 Review Receipt；
- 不修改 Runtime/kernel 语义；
- 不删除旧 Manifest、旧 Receipt 或旧 Stage 路径；
- Stage 已 admission 后不重跑 `plan materialize`（见「Admission 后 Replan 纪律」）。
