---
name: proofloop-plan
description: ProofLoop active planning 指导：调用 `plan materialize` 生成或更新 candidate tasks.md、调度 stage-plan-verifier（SPV）、处理 PLAN_GAP 或 SPV finding、重启后恢复 planning 时使用。
---

# proofloop-plan

本 Skill 是 Brain 的 active planning 方法。

## 加载与调用

加载本 Skill 后，Brain 通过 Runtime CLI 调用 `plan materialize`
（`proofloop plan materialize --json '{"stage":"<id>","input_path":"delivery/stages/<id>/candidate-input.json"}'`）
完成 Plan materialization。命令契约（确定性渲染；可选 `"check": true` 只读复核，
不产生写入）和写入边界（candidate `delivery/stages/<stage-id>/tasks.md`，必要时
同源 `candidate-input.json` 瞬态输入）见 `references/plan-materializer-contract.md`。

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

关键边界：

- 输入是闭合契约：`manifest`、`manifest_path`、`evidence_dir`、`receipt`、
  可执行 Runtime Proof payload、`proof_digest`、`worker_packet`、`cv_packet`、裸的
  实现文件清单、Runtime command、`plan_digest` 和 admission 字段均禁止出现；
- Task 可以携带 Brain 根据 Authority/Contract 明确提供的结构化 `execution_scope`，
  `plan materialize` 只能保留和验证它，不能从 goal、Markdown 或代码搜索推断路径；
- `runtime_proof` 是唯一允许的显式 proof 投影：`spec_refs` 指向当前 candidate
  `tasks.md` 的本地 `proof_spec` entity，`resolved_steps` 必须是非空的闭合集合（canonical
  executable step 或显式 `not_applicable{reason}` boundary，绝不混合 /
  never both）；`proof_digest` 由 Runtime compile 确定性计算，`plan materialize` 不接受
  caller-supplied digest，也不从 Markdown 推断命令；
- `reference_index` 只登记 stable `ref_id` 和 canonical entity ref，不接受
  `file_digest`、`section_digest`（由 Runtime Resolver 在 Manifest compile 时
  root-bound 解析绑定）；`candidate_plan_path` 必须是当前 Stage 的 canonical
  candidate path；`replan` 必须带已有 candidate 的 ref，但不把旧内容当作隐式权威。

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

## Candidate Plan 规则

`tasks.md` 在 admission 前是 candidate Plan source 和人类可读投影，不能授权执行。

允许生成：

- Stage/Slice/Task Goal；
- Authority/Acceptance/Oracle/Seam/Risk refs；
- Dependencies；
- Required Skills；
- 最小执行投影。

Candidate `tasks.md` 的结构约束是闭合的，`plan materialize` 必须 fail closed：

1. 顶层必须有 Stage heading、Stage Goal 的唯一 entity marker 和 canonical entity refs；
2. 每个 Slice 必须有成对的 `<!-- SLICE:<id>:BEGIN -->` / `END` marker；
3. 每个 Slice 必须有唯一 `goal` marker、`Proof Index References`、`Dependencies`、
   `Required Skills` 和至少一个带 entity marker 的 Task；
4. `reference_index` 中 path 等于当前 candidate `tasks.md` 的 `goal`、`task`、
   `acceptance`、`seam`、`oracle`、`risk` 和 `proof_spec` descriptor 都必须有唯一、
   kind/id 对齐的 entity marker；缺失、重复、错 kind 或错 id 必须 fail closed。外部
   Authority refs 只保留引用，不复制 marker；
5. Proof Index 只使用稳定 `ref_id`，并且必须闭合 `goal_ref`、`task_refs`、
   `acceptance_refs`、`seam_refs`、`oracle_refs`、`risk_refs`；risk binding 只能
   指向同一 Slice 的 acceptance/seam refs；
6. 所有 entity ref 必须是 `<root-relative-path>#/entities/<entity-id>`，不能用 heading、
   表格行或全文搜索代替；
7. `Immutable Plan Projection` 只包含 Goal、refs、Dependencies、Required Skills 和
   Task 的 `execution_scope`；`Mutable Execution Projection` 只包含 checkbox、Worker
   Status 和 Current CV Status。Runtime 依据前者计算 authoritative `plan_digest`，
   后者不得参与。`implementation` Task 必须有非空 `code_paths` 和 `test_paths`，
   所有路径必须 root-bound；`evidence-only` Task 不得被投影为 `implement-task`；
8. candidate 状态固定为 `CANDIDATE_ONLY`、未勾选、`NOT_STARTED`、`NOT_RUN`；任何
    完成、执行、CV PASS 或 admission 声明都必须拒绝。

`candidate-only` 与 `out_of_scope` 的语义（不得用 planning-only 文字永久排除
正式 execution Stage）见 contract 的目标与写入边界。

禁止复制或发明：

- 产品验收正文；
- Architecture/Contract/Hard Part 正文；
- 完整 PO/Proof Plan/Risk Facts；
- 裸的实现文件清单或实现方法（Task 的结构化 `execution_scope` 是唯一允许的范围声明）；
- Runtime command 字符串；
- Worker/CV Packet；
- Stage 完成或 Task 完成声明。

`candidate-input.json` 只能是同一结构化 Plan 的瞬态编译输入，不是第二事实源。
`plan materialize` 不生成 Manifest、Evidence directory/file、Receipt、Runtime State，也
不授权执行。纯 checkbox、Worker Status、CV Status 变化不得改变 Runtime 计算的
`plan_digest`；改变 `execution_scope` 必须改变 digest 并使下游 Manifest、Context
和验证结果失效。

## plan materialize → Runtime 交接

`plan materialize` 渲染 tasks.md 后，Brain 按规划循环步骤 8–14 的顺序交接，不能跳步；完整
handoff 链见 contract 的恢复与 Runtime 交接。`plan materialize` 只渲染 candidate
tasks.md（CANDIDATE_READY）或只读复核（CANDIDATE_CHECKED），不调用 compile/validate/
admission 等后续 Runtime 操作。Validator PASS 或 SPV `PLAN_READY`
单独都不授予执行权。

## SPV 调度

SPV 是只读、fresh 的反向验证 Agent。Brain 使用
`references/stage-plan-verifier-template.md` 新建 dispatch；packet 字段、验证顺序、
digest 提取命令和结果路由均以 template 为准。

SPV dispatch 只能发生在最终 Plan、candidate input 和 Evidence skeleton 已进入 stable
Git boundary 且 canonical worktree clean 之后；packet 中的 `snapshot_digest` 必须是
该 boundary 的当前 Git HEAD。SPV_PASS 通过后，如果 Plan、Authority、Manifest binding
和 snapshot 均未变化，`next/context` 不得自动重新 SPV。任何真实 HEAD/snapshot、Plan、
Authority 或其 digest 变化都必须 fail closed，并由 Brain fresh dispatch SPV；不得以
progress、checkbox projection 或 Agent narrative 作为 authority。

## Gap 路由

```text
缺少产品验收或行为权威
→ AUTHORITY_GAP / MISSING_ACCEPTANCE_AUTHORITY

缺少可观察真实边界
→ AUTHORITY_GAP / MISSING_VERIFIABLE_BOUNDARY

缺少可执行验证定义
→ AUTHORITY_GAP / MISSING_EXECUTABLE_ACCEPTANCE

验证可行性未知
→ TECHNICAL_UNKNOWN / VERIFICATION_FEASIBILITY_UNKNOWN

Stage 无法合理分解
→ PLAN_GAP / STAGE_NOT_DECOMPOSABLE

Proof Index 不完整
→ PLAN_GAP / INCOMPLETE_PROOF_INDEX
```

所有非成功结果都必须带 `route_code`、`subtype`、`reason`、
`suggested_owner`、`invalidation_scope` 和 `resume_target`；适用时附带
finding、affected artifacts、work items、Hard Parts 和 evidence。

## 恢复与失效

- Skill 上下文丢失或 `plan materialize` 输出需要重跑时，从 Git、Authority、candidate
  Plan、同源瞬态输入、Manifest、SPV Findings 和 progress snapshot 重新运行；`replan`
  必须重新调用 `plan materialize`。
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

## 流程步骤 → CLI 命令对照

统一调用形式（唯一 public seam）：

```text
node packages/runtime/dist/cli/proofloop.js <domain> <operation> [--request <root-relative-json> | --json <closed-json>] [--project-root <root>]
```

stdout 恰好一个 canonical JSON envelope；exit 0=ok/read-ready，2=blocked/refused/no-write，
1=usage/schema failure。**通用入口优先**：报错给出字段清单时按清单修正重试，不要绕道
读源码找专用脚本。

| 流程步骤 | 实际命令（`node packages/runtime/dist/cli/proofloop.js ...`） | `--json` 参数格式 |
|---|---|---|
| plan materialize（candidate tasks.md 渲染+写） | `plan materialize` | `{"stage":"<id>","input_path":"delivery/stages/<id>/candidate-input.json"}`（input_path 必填；可选 `"check": true`，只读复核不写 → CANDIDATE_CHECKED） |
| plan compile（candidate → Manifest） | `plan compile` | `{"stage":"<id>","input_path":"delivery/stages/<id>/candidate-input.json"}`（input_path 必填；可选 `output_path`） |
| plan validate（Mechanical Validator） | `plan validate` | `{"stage":"<id>"}`（可选 `manifest`） |
| plan initialize-evidence | `plan initialize-evidence` | `{"stage":"<id>"}`（可选 `evidence_dir`） |
| plan refresh-evidence（pre-admission pristine 刷新） | `plan refresh-evidence` | `{"stage":"<id>","previous_manifest_digest":"<64-hex>","mode":"refresh"}`（mode ∈ refresh/recover/rollback） |
| plan admit-stage-plan（Stage Plan admission） | `plan admit-stage-plan` | `{"stage":"<id>","input_path":"<root-relative-admission-request>.json"}`（input_path 指向 admission request 文件；request 内 `type`=`STAGE_PLAN_ADMISSION`（version/schema_version=2），必含 `project_root`、`manifest_path`、`stage_id`、`manifest_digest`、`plan_digest`、`snapshot_digest`、`spv`（`SPV_PASS` 对象，`digest`=computeDigest 不含 digest 字段）） |
| stage next / status | `stage next` / `stage status` | `{"stage":"<id>"}` |
| context prepare（按角色投影） | `context prepare` | `{"stage":"<id>","role":"worker","slice":"<slice-id>","task":"<task-id>"}`（role ∈ planning/spv/worker/cv/committer/stage-reviewer/project-reviewer） |
| context show（digest 读回） | `context show` | `{"stage":"<id>","role":"<role>","ref":".proofloop/context/<digest>.json"}` |
| gate run（Stage Gate） | `gate run` | `{"stage":"<id>"}`（可选 `verification_source` ∈ receipts/git_facts、`re_gate`） |
| review finalize-stage | `review finalize-stage` | `{"stage":"<id>","verdict":"ACCEPTED"|"REPAIR","summary":"<non-empty>"}` |
| doctor run | `doctor run` | 无需请求字段（`--project-root <root>` 即可） |

> 约定：`<id>` 为 canonical Stage ID（`^S\d+$`）；所有路径都是 root-relative，不以 `/`
> 结尾；`admit-stage-plan` 与 `plan compile` 的 `input_path` 语义不同（前者是 admission
> request，后者是 candidate input），不要混用。

## 禁止事项

- 不启动正式 Stage；
- 不派发 Worker/CV/Committer；
- 不执行 `proofloop_stage(next)`；
- `plan materialize` 不生成/更新 Manifest、Evidence、Receipt 或 Runtime State；
- 不写 Stage Plan admission、SPV、Task、CV、Gate 或 Review Receipt；
- 不修改 Runtime/kernel 语义；
- 不删除旧 Manifest、旧 Receipt 或旧 Stage 路径。
