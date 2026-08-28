# Process Discipline Matrix — 当前防复发机制索引

> 本矩阵是 FR-024 的当前索引，记录本模板中可以定位的防复发机制及其权威落点。
> 原始问题记录未随本模板发布；下表编号只作历史导航，本表不复制缺失的历史正文，也不宣称历史问题整体已闭环。
> 行内的代码、Contract、Skill 和测试路径必须以当前仓库实际存在的文件为准；完整行为
> 验证仍以 Runtime/CLI 结果和使用项目的测试为准。
>
> 职责边界：Contract 是语义、字段和状态的权威；Skill 是步骤、分支和完成标准；
> Agent 只定义角色行为与职责；Template 只定义 packet/schema；Runtime 是机械状态与
> Receipt 的唯一写入者。

| 历史编号 | 纪律主题 | 当前机制 | 权威落点 | 可复核方式 |
|---|---|---|---|---|
| 1 | Brain 直接操作 Git | 普通 Git boundary 由 Runtime `boundary close` 建立；唯一例外是 `artifact-archive`：Brain 预执行精确的 `git mv`，CLI 只校验已 staging 的纯 rename 并提交 | `.agents/contracts/brain/commit-boundary.md`；`packages/runtime/src/git-boundary.ts` | `packages/runtime/test/boundary-repair.test.ts` 的临时 Git fixture |
| 2 | admission 后重跑 materialize 重置投影 | Stage admission 后禁止重跑 `plan materialize`；需要 replan 时按 Runtime 的 epoch/currentness 与 recovery 规则保留或恢复已受理成果 | `.agents/skills/proofloop-plan/SKILL.md`；`.pi/brain-workflow.md`；`packages/runtime/src/vnext/replan-epoch.ts`；`packages/runtime/src/vnext/binding-currentness.ts` | 对照 Skill、Runtime 入口和实际 replan fixture；不引用已移除的历史测试路径 |
| 3 | `git checkout --` 丢失实现 | Brain/Agent 不执行恢复性 Git 写操作；恢复前只读 `git status`/`git diff`，边界写入仍走 Runtime CLI，不用 checkout 覆盖工作 | `AGENTS.md`；`.pi/brain-workflow.md`；`.agents/contracts/brain/commit-boundary.md` | Git 只读纪律审计与 Boundary CLI 临时 fixture |
| 4 | admission digest 填错或截断 | packet、Context、Manifest、Plan、Proof Index 和 snapshot digest 使用闭集字段与格式/绑定校验；不由叙事补全 | `.agents/skills/proofloop-execute/references/worker-template.md`；`packages/runtime/src/vnext/worker-admission.ts`；`packages/runtime/src/vnext/commit-admission.ts` | Runtime admission 的拒绝分支与 source/build 检查 |
| 5 | tasks.md 投影位置错误 | Worker 只可改当前 Task 的 checkbox/Worker Status；Stage/Slice/Task contract、refs、依赖、scope、Proof Index 和其他投影保持 immutable | `.agents/skills/proofloop-execute/references/worker-template.md`；`.agents/skills/proofloop-worker/SKILL.md`；`packages/runtime/src/vnext/worker-admission.ts` | Worker Result admission 的 scope/projection 校验 |
| 6 | Slice Commit 的 commit/HEAD 顺序错误 | Boundary 先固定并校验 `expected_head`，提交后由 Runtime 以实际 HEAD 生成/校验 commit facts；Slice Commit admission 只消费已提交的 tuple | `.agents/contracts/brain/commit-boundary.md`；`packages/runtime/src/vnext/commit-admission.ts`；`packages/runtime/src/git-boundary.ts` | `packages/runtime/test/boundary-repair.test.ts` 的 HEAD/commit fixture |
| 7 | CV REPAIR 未及时接纳 | `PASS`/`REPAIR` 立即进入对应 Runtime consumer；repair 是 taskless 的持久交接事实，经过绑定校验后进入 fresh CV recheck，不伪装成 `TASK_COMPLETE` | `.agents/skills/proofloop-execute/SKILL.md`；`.agents/skills/proofloop-worker/SKILL.md`；`packages/runtime/src/vnext/cv-admission.ts`；`packages/runtime/src/vnext/next.ts` | Runtime CV admission/recheck 路由审计 |
| 8 | repair Evidence 标题级别错误 | 每个 Task Evidence 恰好一个 `### <task-id>`；子记录只能用 `####` 或列表项；违规时 admission 明确拒绝并报告位置 | `.agents/skills/proofloop-execute/references/worker-template.md`；`packages/runtime/src/vnext/worker-admission.ts` | Worker Evidence parser/admission 的正反例 |
| 9 | repair scope 越权 | `implement-task`/`recover-task` 才要求非空 root-bound code/test scope；`finalize-slice` 与 `repair` 使用各自的 taskless/evidence 或 bounded failure 规则，不扩大 Context | `AGENTS.md`；`.agents/skills/proofloop-execute/SKILL.md`；`.agents/skills/proofloop-worker/SKILL.md`；`packages/runtime/src/vnext/dispatch.ts` | mode-specific Context/dispatch 校验与 changed-file boundary |
| 10 | Evidence 绑定失效导致连坐 | 已受理且当前的 Slice 由 `binding-currentness` 判定；无关 Slice 不因整本 digest 变化自动失效；需要刷新时使用 Runtime public `plan refresh-evidence` | `packages/runtime/src/vnext/binding-currentness.ts`；`packages/runtime/src/vnext/next.ts`；`packages/runtime/src/vnext/evidence-refresh.ts`；`tech-spec/contract-state-matrix.md` | currentness/replan fixture 与 Runtime readback |
| 11 | 用 general 承载 Worker 任务 | Worker 必须由 Runtime Primary Next Action 和 active Worker Skill/template 路由；Host transport 在 Session 创建时固定，不能由临时 agent 或叙事替换 | `.agents/contracts/brain/herdr-link-worker-lifecycle.md`；`.agents/skills/proofloop-execute/SKILL.md`；`.pi/brain-workflow.md` | dispatch packet、route 和 recovery 审计 |
| 12 | 上游 cwd 修复未进入本地基线 | 当前模板不保留独立历史问题正文；导入或修复前以当前 Git status/diff、Trust Root 和适用 Contract 核对基线，未能证明时 fail closed | `AGENTS.md`；`.agents/contracts/brain/commit-boundary.md`；`.pi/brain-workflow.md` | Git boundary 前置检查；不引用已清理的历史记录 |
| 13 | 测试写入项目配置造成污染 | 测试或 fixture 使用临时 Git/临时目录，不把 `.proofloop` 或项目配置作为测试事实源；模板只引用当前可见的 Node test fixture | `packages/runtime/test/boundary-repair.test.ts`；`packages/runtime/test/slice-boundary-e2e-helper.ts`；`packages/runtime/test/slice-boundary-e2e.test.ts` | 临时目录清理、测试前后配置对照；测试文件若未纳入提交仍不作为 Runtime 权威 |

## 使用说明

- 本表是当前机制和落点索引，不是缺失历史文档的替代品，也不计算历史问题覆盖率。
- “可复核方式”指向可执行的验证入口或事实审计；它不把文档存在、单个测试通过或 Agent 叙事升级为 Stage Gate、Review 或 Project Acceptance。
- 若使用项目需要验证某个历史问题，应在该项目的当前 Contract/Skill 和测试中建立证据，再回填对应落点；不得恢复或重新引用已清理的 legacy 路径。
