# `plan materialize` CLI 命令契约

本 Contract 是 `proofloop-plan` 的 `plan materialize` 命令契约。Brain 重启后
只需读取本 Contract 和 `SKILL.md`，即可解析命令用法、输入、输出和下一跳。

## 命令用法

```text
node packages/runtime/dist/cli/proofloop.js plan materialize --json '{"stage":"<id>","input_path":"delivery/stages/<id>/candidate-input.json"}'
```

（可选 `"check": true`：只读复核已渲染的 candidate `tasks.md`，零写入 → `CANDIDATE_CHECKED`；
不传 `check` 或 `"check": false` 为生成/更新模式 → `CANDIDATE_READY`。）

`plan materialize` 是 Runtime CLI 的确定性命令，是 candidate `tasks.md` 的唯一
写入者。它不是 SPV 或 Stage Plan admission；它只渲染 candidate Plan，不执行
compile/validate/admission 或 Evidence 初始化。Brain 必须先加载 `proofloop-plan`，
再按本 Contract 调用该命令；不能把 Brain 的直接手写编辑当作 materialization。

## 目标与写入边界

目标：把 Brain 已选择且已完成 Authority Readiness 的结构化 Stage/Slice/Task
输入，渲染为可验证的 candidate `tasks.md`。

允许持久化：

- `delivery/stages/<stage-id>/tasks.md`；
- 必要时，与本次输入完全同源的瞬态输入（例如
  `delivery/stages/<stage-id>/candidate-input.json`）。

禁止持久化：

- 任意 Manifest 或 `.proofloop/manifests/**`；
- 任意 Evidence directory/file；
- 任意 Receipt、SPV/admission、Runtime State、Gate 或 Review artifact；
- Worker/CV output、代码或实现文件；
- 任意第二份独立 Plan/Authority fact source。

`plan materialize` 只渲染 candidate `tasks.md`，不写 Receipt，不派发
Worker/CV，不执行 `proofloop stage next`。candidate output 永远是
`CANDIDATE_ONLY`，不能授权执行。

`CANDIDATE_ONLY` 只描述 `plan materialize` 产出的 admission 前投影。若 Brain/Authority
已将某个 Stage 选为正式 execution Stage，输入的 `out_of_scope` 必须只排除
`plan materialize` 不拥有的写入和 Runtime 事实（Manifest、Receipt、Worker/CV/Commit/Gate/Review
admission），不能把 admission 成功后的 Stage Goal 永久标为 out of scope。正式执行事实
仍必须由 `proofloop-execute` 和 Runtime/Host admission owners 产生；Gate 为 facts-only
（S08-REVIEW-010 / b6b0d3a：active candidate/compile seam 不接受 `runtime_proof` 投影，Gate 只消费 facts。）

`plan materialize` 返回后，Brain 按 `SKILL.md` 的 candidate-artifact、stable-boundary、fresh SPV 和
admission handoff 执行；该命令本身不编译 Manifest、不初始化 Evidence、不执行 SPV/admission。

## 必需输入

输入必须是一个闭合 JSON 对象。字段如下；未知字段必须 fail closed：

```yaml
schema_version: 2
mode: initial | replan
binding_mode: slice-local   # 可选（S13）；仅允许 "slice-local"，省略 = legacy stage-wide；未知值/类型错误必须 fail closed
caller: brain
owner: pluginv2-active-plan-materializer  # Runtime 保留的 canonical owner/compatibility identifier；不代表已退役 OpenCode Plugin 或当前 package
project_root: <absolute canonical trust root>
stage_id: <candidate stage id>
candidate_plan_path: delivery/stages/<stage-id>/tasks.md
selected_work_item_refs:
  - <root-relative-path>#/entities/<AWI-id>
authority_entity_refs:
  - <root-relative-path>#/entities/<entity-id>
existing_plan_ref: null | delivery/stages/<stage-id>/tasks.md
finding_refs: []
stage_goal:
  entity_id: <stage-id>-goal
  ref_id: REF-<stable-id>
  goal: <behavior-level goal>
  refs: [<stable ref_id>]
dependencies: []
constraints: []
out_of_scope: []
reference_index:
  - ref_id: REF-<stable-id>
    kind: goal | task | acceptance | seam | oracle | risk | proof_spec
    ref: <root-relative-path>#/entities/<entity-id>
slices:
  - slice_id: <stage-id>-A
    goal_entity_id: <stage-id>-A-goal
    goal: <observable slice goal>
    proof_index:
      slice_id: <stage-id>-A
      goal_ref: REF-<slice-goal>
      task_refs: [REF-<task>]
      acceptance_refs: [REF-<acceptance>]
      seam_refs: [REF-<seam>]
      oracle_refs: [REF-<oracle>]
      risk_refs:
        - ref_id: REF-<risk>
          applies_to_acceptance_refs: [REF-<acceptance>]
          applies_to_seam_refs: [REF-<seam>]
    dependencies: []
    required_skills: []
    evidence_path: delivery/stages/<stage-id>/evidence/<slice-id>.md
    tasks:
      - task_id: <stage-id>-A-T01
        entity_id: <stage-id>-A-T01
        goal: <goal-level task>
        refs: [REF-<task>]
        dependencies: [<stage-id>-A]
        required_skills: []
        execution_scope:
          kind: implementation | evidence-only
          code_paths: []
          test_paths: []
          forbidden_paths: []
        checkbox: false
        status: NOT_STARTED
        cv_status: NOT_RUN
```

### 输入不变式

1. `project_root` 是 canonical trust root；`candidate_plan_path` 只能是
   `delivery/stages/<stage-id>/tasks.md`，不能是绝对路径、symlink escape 或 `..`
   路径。
2. 所有 `reference_index[].ref`、`selected_work_item_refs` 和
   `authority_entity_refs` 都必须使用精确的
   `<root-relative-path>#/entities/<entity-id>` grammar。`plan materialize` 不解析全文、
   heading、表格行或模糊 anchor；file/section digest 由 Runtime Resolver 产生。
3. `reference_index` 的 `ref_id` 唯一，kind 必须匹配每一个 Proof Index 使用点。
   `plan materialize` 不接受 `file_digest`、`section_digest` 或用户提供的 `plan_digest`。
4. `binding_mode` 可选：仅接受 kernel 闭集 `VNEXT_BINDING_MODES` 中的 `"slice-local"`，
   省略表示 legacy stage-wide；任何未知值或类型错误必须 fail closed，不得静默回退 legacy。
   Materializer 只在 normalized input/plan 上保留该字段供 Runtime `plan compile` 使用；
   tasks.md 渲染不得使用该字段，且不得借此产生 Manifest/Receipt/Evidence/执行授权或第二事实源。
5. Stage、Slice、Task 的 entity marker 必须唯一且与对应 reference 的 entity id
   一致；对于 `reference_index` 中 path 等于当前 candidate `tasks.md` 的
   `goal`、`task`、`acceptance`、`seam`、`oracle`、`risk` 和 `proof_spec`
   descriptor，也必须各有唯一且 kind/id 对齐的 entity marker。外部 Authority
   file 的 ref 只保留引用，不得在 candidate 中伪造 marker。Task ID 必须属于其
   Slice，Slice ID 必须属于当前 Stage。
 6. 每个 Slice 必须有唯一 `goal_ref`、至少一个 `task_ref`、至少一个
    `acceptance_ref`、`seam_ref`、`oracle_ref` 和显式 `risk_refs` 数组。
    risk binding 只能绑定同一 Proof Index 的 acceptance/seam refs。
 7. 每个 Slice 和 Task 必须声明 `dependencies` 与 `required_skills` 字段；数组可
   为空，但字段不能省略。Slice 间依赖必须是 DAG。
 8. candidate-only mutable values 固定为 `checkbox: false`、`status: NOT_STARTED`
    和 `cv_status: NOT_RUN`。任何 `[x]`、执行状态、CV verdict、completion claim
    都是 `PLAN_DEFECT`。`implementation` Task 的 `execution_scope.code_paths`
    与 `test_paths` 必须非空；`evidence-only` Task 不得进入 `implement-task` dispatch。
 9. `manifest_path`、`evidence_dir`、Receipt、可执行 Runtime Proof payload、
   `proof_digest`、Worker/CV packet、裸的实现文件清单和 admission 字段不属于输入
   schema。Task 可以携带由 Brain 根据 Authority/Contract 明确给出的结构化
   `execution_scope`；`plan materialize` 不得从 goal、Markdown 或代码搜索推断 scope。
   **candidate input 不接受 `runtime_proof` 投影**（b6b0d3a / S08-REVIEW-010 关闭：active vNext compile output 不产生该字段；Kernel 仍保留可选兼容类型，但 Gate 为 facts-only，不执行或绑定该字段；
   build/test 由 Stage Review 承担）。`reference_index` 仍可登记指向
   candidate `tasks.md` 的 `proof_spec` 实体（若未来需要显式 proof 声明），但
   materialize 不生成、不校验可执行 step 投影。
10. `execution_scope` 是 immutable Plan projection 的一部分，参与 `plan_digest`；
   纯 checkbox/status/CV projection 不得改变 digest，scope 变化必须使 Manifest、
   Context 和旧验证结果失效。

### 常见输入错误与正确写法

- **refs 必须同时登记**：`selected_work_item_refs`、`authority_entity_refs` 以及
  Proof Index 用到的每个 `ref_id` 都必须同时出现在 `reference_index` 中
  （缺登记 → `INCOMPLETE_PROOF_INDEX` / `MISSING_ACCEPTANCE_AUTHORITY`）。
- **字段不由 materializer 推断**：candidate input 只接受 Contract 声明的结构化字段；可执行 proof 命令、Manifest、Receipt、Evidence 初始化和 admission 字段均由 Runtime 的后续 consumer 负责。
- **路径不以 `/` 结尾**：`execution_scope.forbidden_paths`、`code_paths`、
  `test_paths`、`evidence_path` 等路径不能以 `/` 结尾（尾斜杠产生空路径段，
  违反 root-relative 校验）。
- **`--check` 要求目标已存在**：`CANDIDATE_CHECKED` 是只读复核模式，只校验
  已生成的 candidate `tasks.md`；首次生成前不要用 `--check`（文件不存在 → fail
  closed），先用生成模式产出文件。

## 输出契约

成功时，命令 stdout 是 canonical JSON envelope（`ok: true`），不是自然语言：

```yaml
ok: true
result: CANDIDATE_READY | CANDIDATE_CHECKED
owner: pluginv2-active-plan-materializer  # Runtime 保留的 canonical owner/compatibility identifier；不代表已退役 OpenCode Plugin 或当前 package
caller: brain
stage_id: <stage-id>
candidate_plan_path: delivery/stages/<stage-id>/tasks.md
candidate_only: true
writes:
  - delivery/stages/<stage-id>/tasks.md
runtime_handoff:
  manifest: DEFERRED_TO_RUNTIME
  validator: DEFERRED_TO_RUNTIME
  evidence_initializer: DEFERRED_TO_RUNTIME
  spv: FRESH_DISPATCH_BY_BRAIN
  admission: DEFERRED_TO_RUNTIME
```

`CANDIDATE_CHECKED` 是只读 `--check` 的成功结果；它不更新文件。
命令可以在 process output 中返回诊断性结构信息，但不能把该信息当作
Manifest、Receipt 或执行授权。

## Candidate `tasks.md` 结构

输出必须包含以下可机器检查的结构：

```markdown
# Stage <stage-id> — candidate

## Stage Goal
<!-- proofloop:entity id="<stage-id>-goal" kind="goal" -->
<goal>

## Stable Entity References
...

## Immutable Plan Projection
...

## Mutable Execution Projection
...

## Slice Graph
...

## Slice <stage-id>-A — candidate
<!-- SLICE:<stage-id>-A:BEGIN -->
### Goal
<!-- proofloop:entity id="<stage-id>-A-goal" kind="goal" -->
<goal>
### Proof Index References
goal_ref: <ref_id>
task_refs: [<ref_id>]
acceptance_refs: [<ref_id>]
seam_refs: [<ref_id>]
oracle_refs: [<ref_id>]
risk_refs: [<ref_id> + bindings]
### Dependencies
...
### Required Skills
...
### Tasks
<!-- proofloop:entity id="<stage-id>-A-T01" kind="task" -->
- [ ] <task-id> — <goal>
### Immutable Plan Projection
...
### Mutable Execution Projection
...
<!-- SLICE:<stage-id>-A:END -->

## Candidate Entity Markers
<!-- proofloop:entity id="<candidate-local-acceptance-id>" kind="acceptance" -->
<!-- proofloop:entity id="<candidate-local-seam-id>" kind="seam" -->
<!-- proofloop:entity id="<candidate-local-oracle-id>" kind="oracle" -->
<!-- proofloop:entity id="<candidate-local-risk-id>" kind="risk" -->
<!-- proofloop:entity id="<candidate-local-proof-spec-id>" kind="proof_spec" -->
<!-- 注：proof_spec marker 仅在 candidate 显式声明 proof_spec 引用时生成；
     candidate input 不接受 runtime_proof 投影（b6b0d3a / Gate facts-only）。 -->
<candidate-only reference projection; external Authority refs have no marker>
```

`Immutable Plan Projection` 包含 Goal、stable refs、Dependencies 和 Required Skills；
`Mutable Execution Projection` 只包含 checkbox、Worker Status 和 Current CV Status。
`plan materialize` 不把 digest 写入 Markdown；Runtime 以 immutable projection 计算
authoritative `plan_digest`，所以 mutable projection 不得改变它。

## 返回与路由

### Success

- `CANDIDATE_READY`：candidate `tasks.md` 已由 `plan materialize` 生成或更新；下一步是
  Runtime compile/Validator。
- `CANDIDATE_CHECKED`：输入和 candidate 结构通过只读 check；不产生写入。

### Non-success

```yaml
ok: false
result: BLOCKED | PLAN_DEFECT | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER
route_code: PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER | OWNER_MISMATCH
subtype: <specific-subtype>
reason: <description>
affected_artifacts: []
suggested_owner: Brain | proofloop-plan | User
invalidation_scope: []
resume_target:
  owner: Brain | proofloop-plan | User
  phase: STAGE_PLANNING | AUTHORITY_READINESS | RECOVERY_OR_EXCEPTION
  stage: <stage-id | none>
```

Canonical subtypes include：

- `ACTIVE_PLAN_MATERIALIZER_UNRESOLVED` → `OWNER_MISMATCH`；
- `MISSING_ACCEPTANCE_AUTHORITY`、`MISSING_VERIFIABLE_BOUNDARY`、
  `MISSING_EXECUTABLE_ACCEPTANCE` → `AUTHORITY_GAP`；
- `INCOMPLETE_PROOF_INDEX`、`STAGE_NOT_DECOMPOSABLE`、`CANDIDATE_EXISTS` →
  `PLAN_GAP`；
- `MISSING_ENTITY_MARKER`、`DUPLICATE_ENTITY_MARKER`、`ENTITY_MARKER_KIND_MISMATCH`、
  `INVALID_ENTITY_MARKER`、`UNEXPECTED_ENTITY_MARKER` → `PLAN_GAP`；
- `VERIFICATION_FEASIBILITY_UNKNOWN` → `TECHNICAL_UNKNOWN`；
- `CANDIDATE_PATH_ESCAPE`、`CANDIDATE_SCHEMA_INVALID` → `RUNTIME_BLOCKER` 或
  `PLAN_GAP`，按事实来源选择，不得吞掉错误。

## 恢复与 Runtime 交接

`plan materialize` 输出丢失或需要重跑时，Brain 重新读取 Git、Authority、candidate
input、已有 candidate `tasks.md`、Manifest 和 Findings，再以 `mode: replan`
重新调用 `plan materialize`（恢复与失效规则详见 `SKILL.md` 的恢复与失效）。

只有下面的 Runtime handoff 完成后，candidate 才能进入执行前流程：

```text
CANDIDATE_READY
→ plan compile
→ plan validate
→ plan initialize-evidence
→ re-read Plan + candidate-input + Manifest + all Evidence skeletons
→ final stable Git boundary (canonical root + clean worktree)
→ fresh stage-plan-verifier (PLAN_READY, snapshot = current Git HEAD)
→ plan admit-spv（SPV 结果纳入），适用时
→ Runtime Stage Plan admission / canonical Receipt
→ stage next + Context projection
→ proofloop-execute / Worker
```

`PLAN_READY`、Validator PASS 或 `CANDIDATE_READY` 均不是执行授权。Runtime 是
Manifest、Validator、Evidence initializer、SPV/admission 和 Receipt 的唯一 owner，
不从 progress 或 Agent narrative 推导缺失 authority；SPV 复用与 fresh 规则见
`SKILL.md` 的恢复与失效。
