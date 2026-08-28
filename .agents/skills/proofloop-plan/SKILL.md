---
name: proofloop-plan
description: STAGE_PLANNING：Stage Goal/Work Items 已选定时生成 candidate Plan；在 PLAN_GAP、SPV finding 或重启恢复时重新核对规划绑定，直至 fresh SPV PLAN_READY 并完成 Runtime Stage Plan admission。
---

# proofloop-plan

本 Skill 只负责 STAGE_PLANNING 的判断和有序交接。Contract 定义语义、字段、状态和闭集输入/输出；
Template 定义 dispatch packet/schema；Runtime 定义 Manifest、Evidence、Receipt、admission 和状态。

## Phase ownership

- **进入**：Stage Goal、Architecture Work Items 和必要 Authority 已就绪。
- **完成**：candidate Plan/Evidence skeleton 经过 stable Git boundary，Runtime compile/validate PASS，
  fresh SPV 返回 `PLAN_READY`，随后 Runtime Stage Plan admission 成功。
- **交接**：admitted Manifest、Plan digest 和 Context 交给 `proofloop-execute`；阶段切换由 Runtime 驱动。
- **回退**：Authority 变化回对应 authority Skill；计划缺口继续留在本 Skill。

## 加载链与事实源

1. 本 Skill：规划步骤、分支和完成标准。
2. `.agents/skills/proofloop-plan/references/plan-materializer-contract.md`：`plan materialize` 的
   request/schema、candidate projection、输出和失败路由；调用前逐字段核对。
3. `.agents/skills/proofloop-plan/references/stage-plan-verifier-template.md`：fresh SPV packet、
   helper、验证顺序和结果 schema。
4. Brain dispatch 指定的 active Contract/Authority：只读取稳定 ref，不复制正文。

`plan materialize` 是 candidate `tasks.md` 的唯一写入者；Brain 不手写 candidate Plan。Candidate
不授予执行权，`CANDIDATE_READY`、Validator PASS 和 SPV `PLAN_READY` 都不等于 admission。

## 责任分工

- Brain：选择 dependency-ready AWI、确认 Authority readiness、调用 Runtime/本 Skill、接收结构化结果并路由。
- 本 Skill：读取稳定 refs，构造最小闭合输入，调用 `plan materialize`，准备 fresh SPV。
- Runtime：compile、validate、Evidence skeleton、stable-boundary 校验、SPV/admission Receipt 和执行授权。
- SPV：只读反向验证；不编辑 Plan、Evidence、checkbox、Receipt 或 Git。

## 有序规划循环

每次循环只处理当前 Stage，并在每步结束核对完成标准：

1. **REHYDRATE**：读取 Git、Authority、candidate Plan/input、Manifest、Evidence、Findings 和
   `progress.md`。完成标准：当前 Stage、输入 digest、已有 admission/replan epoch 和待处理 finding 均可从持久化事实定位。
2. **确认 readiness**：确认 Work Item 依赖、Hard Part 状态和 Authority refs 已满足；未满足时返回
   `AUTHORITY_GAP`、`TECHNICAL_UNKNOWN` 或用户决定路由。完成标准：每个被使用的 authority/entity ref 都稳定、root-bound 且可解析。
3. **核对代码 scope**：构造每个 Task 的结构化 `execution_scope` 前，读取关键模块/数据流；每个
   `code_paths`/`test_paths` 均能定位实际文件或符号，且不从 goal、Markdown 或模糊搜索推断。完成标准：
   每个 implementation Task 的 code/test scope 非空、root-bound、无 forbidden overlap。
4. **Materialize candidate**：生成最小 Stage/Slice/Task、Dependencies、Required Skills、Proof Index
   和稳定 refs，调用 `plan materialize`。完成标准：收到 canonical `CANDIDATE_READY`（或只读
   `CANDIDATE_CHECKED`），candidate `tasks.md` 与同源 input 已落盘，且没有 Runtime-owned 写入。
5. **准备 candidate artifacts**：按 Runtime Contract compile/validate 并初始化 Manifest-declared
   Evidence skeleton；重新读取 Plan、input、Manifest 和 Evidence，核对 root、scope、digest、refs。
   完成标准：Validator PASS、每个 declared Evidence path 可读且仍为 candidate skeleton，任何失败都保留
   typed Runtime finding。
6. **建立 stable Git boundary**：在 canonical root 按 `commit-boundary.md` 建立最终 candidate
   Plan/Evidence boundary；worktree 必须 clean（正常 ignored `.proofloop` Runtime artifacts 除外）。
   完成标准：Boundary CLI 返回成功且 Brain 重读 HEAD、index、status、Plan/input、Manifest 和 Evidence；
   不直接运行 `git add`/`git commit`。
7. **Dispatch fresh SPV**：使用 `stage-plan-verifier-template.md`，把当前 HEAD、Manifest/Plan/Reference/
   Proof Index digest 和 helper command 完整绑定。SPV 先执行闭合 helper，再执行全部计划闭环检查。完成标准：
   仅在 helper `valid: true` 且 SPV 返回 `PLAN_READY` 时继续；其他结果按下方路由处理。
8. **Admission**：Brain 将 fresh SPV authority 交给 Runtime Stage Plan admission，再读取 admission Receipt。
   完成标准：Receipt 绑定当前 Stage、Manifest、Plan、SPV 和 snapshot，且 admission 明确为 admitted；否则
   返回 `RUNTIME_BLOCKER`/`EVIDENCE_GAP`，不派发 Worker。
9. **Handoff**：admission 成功后调用 `proofloop stage next`，只把 Runtime 返回的 Context 和唯一
   `Primary Next Action` 交给 `proofloop-execute`。完成标准：Stage action、Context digest 和
   `Manifest.plan.ref` 可交叉核对，且没有从 tasks narrative 补全字段。

## SPV 与失败路由

- `PLAN_READY`：只允许 Runtime Stage Plan admission；不直接进入 Worker/CV/Boundary/Gate/Review。
- `PLAN_DEFECT` / `PLAN_GAP`：读取 finding 的 concrete counterexample，修复 candidate/refs/scope 后从
  第 3 步重新 compile/validate；不以局部文字掩盖上游 authority 不一致。
- `AUTHORITY_GAP`：回对应 Authority Skill，并使真实下游 candidate/Manifest/Evidence 失效。
- `TECHNICAL_UNKNOWN`：回 Researcher/Prototype；未经验证不改 Authority 或 Plan 语义。
- `RUNTIME_BLOCKER`：保留 candidate 和 Git 事实，修复工具/权限后从持久化事实恢复。
- 缺少 entity/ref、digest、Evidence 或输入不闭合：fail closed，不能由 progress、checkbox、Agent narrative 或旧缓存补齐。

所有非成功结果都必须保留 Contract 规定的 `route_code`、`subtype`、`reason`、`affected_artifacts`、
`suggested_owner`、`invalidation_scope` 和 `resume_target`。

## Admission 后 replan

Stage Plan admission 后不重新运行 `plan materialize`，因为确定性渲染会重置已受理投影。确需 replan 时：

- 保留/恢复已受理 Slice 的 checkbox/Worker Status projection，或走 Runtime 的 recover/re-admission 流程；
- 新模式的 currentness 由 Receipt/binding 判定，不能用投影重置覆盖；
- 任何 Plan、Goal、Proof Index、Acceptance/Oracle/Seam/Risk ref、Dependencies 或 scope 变化，都重新
  compile/validate、恢复投影、fresh SPV 和 admission；
- 不重开无关的已完成 Stage。

## 重启验证

重启后从 Git、Authority、candidate input/Plan、Manifest、Evidence、Findings 和 Receipts 重新建立上下文，
不依赖 session memory。至少验证：

```text
npx tsc -b --force packages/kernel packages/runtime
node packages/runtime/dist/cli/proofloop.js --help
git diff --check
```

验证事实以文件、Runtime canonical JSON、真实 exit code 和 Git 状态为准；使用项目若另有测试命令，按当前
项目 Contract 执行，不在本 Skill 缓存不存在的测试工具。

## Runtime CLI 指针与硬边界

所有 planning operation 使用 `node packages/runtime/dist/cli/proofloop.js`；精确 domain/operation、request
字段、exit code 和 path 约束以对应 Contract 与当前 CLI 源码为准；涉及 Stage composition route 时还要核对
`packages/runtime/src/cli/vnext-route-table.ts`。当前 `--help` 只返回全局 usage/domain 列表，不提供
operation-specific 字段或 closed schema，不作为这些细节的权威来源。本 Skill：
- 不启动正式 Stage，不派发 Worker/CV，不调用 `stage next` 之外的执行 action；
- 不写 Manifest、Context、Evidence、Receipt、Gate/Review 状态，不修改 Runtime/kernel 语义；
- 不删除旧制品，不把 candidate projection 当作 execution authority；
- 不在 Stage admission 后重新 materialize；恢复和 replan 只走上述持久化路径。
