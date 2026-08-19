# Hard Parts Register — ProofLoop OpenCode Plugin

> 硬点 = AI 可能跳过、伪造或过度简化的实现风险。全部为 `IDENTIFIED`；阻断性硬点必须在依赖它的 Stage 之前解决。pluginv2 的技术硬点来自已确认 `PRD.md` 与 `ProofLoop_pluginv2_流程优化方案.md` 的技术参考，不创建第二个产品权威。

| ID | Hard part | Status | Why hard | Forbidden shortcuts | Minimum acceptable implementation | Acceptance evidence | Human confirmation | Deferral approval | Residual risk |
|---|---|---|---|---|---|---|---|---|---|
| HP-001 | opencode plugin API 能力边界（OC-0 Spike） | VALIDATED（OC-01 加载规则已更正；真实 CLI 复核已完成） | 宿主工具权限、hook 生命周期、agent 身份、取消支持文档不全/不稳定；错误假设会导致 FR-007/008..011 实现返工 | 不 spike 直接假设宿主能力；把"假设支持"写成实现；跳过 Compatibility Matrix；把 `opencode.json` 本地路径当作本地插件支持 | 真实加载 spike + 官方加载规则复核：验证 plugin 函数导出、工具注册与权限、hook 触发、directory/worktree、cancellation、logging、agent identity；产出可复核 Compatibility Matrix（每能力：支持/不支持/降级方案）+ 决策记录；真实 CLI 工具注册断言已由 AWI-017 测试完成 | `tech-spec/host-compatibility.md` + built-entry seam 测试 + `test/opencode-cli-integration.spec.ts`（旧 spike 文件已清理，不作为唯一证据） | required | — | 宿主升级破坏兼容；本地入口/dist/runtime.lock 属于分发与初始化边界，fresh checkout 必须显式包含/构建后再加载 |
| HP-002 | 角色隔离与工具权限（FR-007） | IDENTIFIED（方案已定，待实现） | 宿主可能不支持按 agent 隔离工具；调用者身份可能不可得；校验做成空操作是常见假实现 | 只依赖宿主 permission 无插件内校验；角色校验空实现；把 deny 写成 allow | 宿主权限 + 插件内二次校验（身份不可得时用可用上下文信号 + 文档化限制）；角色×工具矩阵测试全绿 | 角色矩阵测试（每角色尝试每工具：期望拒绝/允许）+ 文档化限制说明 | required（方案经 OC-0 已定：agent.tools deny+allow+execute 二次校验） | — | 权限绕过风险（文档化 + 运行时校验兜底） |
| HP-003 | Hooks 真实生效（FR-008..011） | IDENTIFIED（方案已定，待实现） | hook 依赖宿主事件机制，部分生命周期可能不触发；纯单元测试无法证明真实触发 | 声明式实现不验证触发；mock 静态断言当真实验证；跳过保护路径真实拦截测试 | 真实宿主加载测试：4 个 hook 各有一个真实触发场景验证（写受保护路径被拦、脏标记设置、旧 CLI 被阻、压缩注入恢复指针） | host integration 测试 + 手工验证记录 | required（方案经 OC-0 已定：before fail-closed / after 观察；compaction 保留集成测试） | — | 宿主 hook 语义差异 → adapter 收敛 + 文档化 |
| HP-004 | CLI/Plugin parity 完整覆盖（FR-014） | IDENTIFIED | 双入口易漂移；Receipt digest 要求字节级一致；"功能等价"不等于"规范 JSON 一致" | 只测部分操作；用功能等价代替字节级一致；跳过 digest 比较 | 全部工具操作 × 代表性 fixture：五维对比（Finding Codes / Next Action / Receipt 规范 JSON / Digest / Gate verdict）；纳入每次 Stage Gate 持续执行 | parity 测试集全绿 + 每次 Stage Gate 报告 | optional | — | 行为漂移 → parity 门捕获 |
| HP-005 | 真实 Git workflow（FR-015） | IDENTIFIED | 真实 git 操作（commit/no-ff merge/integration）环境敏感；mock git 会掩盖问题 | 用 mock git；只测单 slice；跳过真实 merge | 两个真实 Slice 完整闭环（CV → commit → no-ff integration → gate）→ Stage Gate Receipt PASS + 真实 git 历史 | 真实 fixture 的 Stage Gate Receipt（PASS）+ git log 记录 | optional | — | 环境差异（git 版本/分支策略） |
| HP-006 | 会话恢复确定性（FR-016） | IDENTIFIED | 状态来源多（Git/Receipts/tasks.md/evidence），恢复一致性难验证 | 用会话内存恢复；跳过 kill 测试 | kill 会话后仅靠 Git/Receipts 恢复，reconcile 结果与中断前一致（重启确定性） | 恢复测试（B3 已验证 runtime 侧；插件侧透传测试） | optional | — | 未提交数据丢失（记录为已知限制） |
| HP-007 | Token 预算达成（FR-012 + 指标） | IDENTIFIED | 工具输出易膨胀；旧方案基线测量难复现；"达标"容易被口头声明 | 不做测量直接声明达标；只测工具 schema 不测真实输出 | compact renderer 实施（status ≤1000 / next ≤1500 / findings ≤20 / receipt ref+digest）+ 同一 fixture 对照测量（不高于旧方案、目标 ≥10% 降低） | token benchmark 记录（数据 + 结论） | optional（未达标时 required） | 未达标 → 用户决策 | 测量方法学差异 |
| HP-008 | Gate/E2E 进程执行可靠性 | IDENTIFIED | 超时/取消/进程树清理在真实场景易泄漏 | 忽略清理；吞掉超时 | runtime 已实现（B1a/B1b 验证：runProcess/spawnService/cleanup）；插件透传 + 集成测试（无残留进程） | 已有 runtime 测试 + 插件集成测试 + ps 检查 | optional | — | 平台差异（POSIX/Windows 已适配） |
| HP-009 | pluginv2 权威、Plan admission 与 Context handoff 完整性 | IDENTIFIED | candidate、Manifest、SPV、Stage Plan admission、Context、Evidence 和 Git snapshot 存在多重 digest/owner 边界；任一层被 Agent narrative 补全都会造成未授权 Worker 或不可恢复的 stale authority；缺失 executable scope 还会让错误在 Worker 阶段才暴露 | 手工构造 Context/Receipt；把 candidate/SPV 当执行授权；忽略 snapshot/plan/reference digest；以 checkbox/progress 判断完成；在 dirty worktree 上 SPV/admission；用内部函数替代真实 Host/CLI/filesystem seam；以 Evidence path 作为 implement Task 的默认 scope | external、root-bound、可解析 entity refs；每个 implement Task 的 immutable execution scope（code/test/forbidden paths）进入 Plan digest；Evidence skeleton 与 candidate Plan/input 在 fresh SPV 前完成最终 clean Git boundary；Runtime-only Manifest/Stage Plan/Context/Evidence boundary；fresh SPV + Stage Plan admission；`proofloop_stage(next)` 只产生包含合法 scope 的可验证 Context；scope 缺失/越界/evidence-only 时在 dispatch 前 bounded fail；parity、TOCTOU/path/security 和 restart evidence | S08-A..D acceptance/seam/oracle/risk refs + Runtime Receipt/readback + clean-boundary/stale-HEAD regression + scope positive/negative + parity/security/recovery tests | required | — | replan/re-admission 与旧 ignored artifacts 必须保持 write-once、不可隐式迁移 |
| HP-010 | 统一 adversarial-first CV 与 Evidence 读取顺序 | IDENTIFIED | 删除 CV Level/Proof Profile 后，仍需保证每次 initial CV 独立反驳、Evidence 后读、repair 后 fresh bounded recheck；否则容易把 Worker 声明当作证明 | 先读 Evidence 再设计反例；用单一测试代替反驳；复用旧 CV session 越过输入变化；把 REPAIR/REPLAN/BLOCKED 混写为 PASS | CV 使用 Acceptance/Seam/Oracle/Risk refs；先反驳再读 Evidence；只返回 closed verdict；repair 后 fresh recheck，输入边界变化时 fresh initial CV | CV Contract、Runtime admission、fresh session/recheck 和 plugin parity 测试 | required | — | 旧等级/Profile 制品残留导致错误路由或不完整迁移 |
| HP-011 | pluginv2 切换、回退与持久事实恢复 | IDENTIFIED | 新流程必须逐步替换旧 plugin；Contract Foundation、Host parity、Gate/Review、Project Acceptance 和恢复未完成前不能删除旧路径或自动迁移旧制品 | 以 progress/文档宣称切换；静默读取旧 Receipt/Stage；长期混用 legacy/new；Git snapshot 改变后继续执行 | 明确切换 Gate；旧 plugin 可回退；旧制品 fail closed；authority/plan/snapshot 变化按范围失效；session 丢失后从 Git/Manifest/Receipt/Evidence 重建 | pluginv2 cutover matrix、migration fail-closed、restart/recovery、Project Acceptance 和 real Host tests | required | — | 回退边界与发布时机需用户/维护者决策 |

## S10 cutover risk entity

### S10 cutover risk（HP-011 可引用实体）
<!-- proofloop:entity id="PLUGINV2-S10-CUTOVER-RISK" kind="risk" -->
- `irreversible_operation: true` — S10-E cutover 删除 v1 stage CLI consumer、legacy CV（sync-cv-status/cv_level）、旧单用途 scripts 与 Host legacy 权限是不可逆操作，只能在 Acceptance A–E 全绿与明确切换 Gate 后执行；删除清单在 cutover 前由 Review 确认。
- `migration: true` — legacy/v1 与 vNext 必须显式隔离；旧 artifact 继续显式检测 fail closed，不得静默升级或回退解释。
- `persistent_state: true` — 切换后从 Git/Manifest/Receipt/Evidence 重建；authority/plan/snapshot 变化按范围失效。
- `core_state_machine: true` — cutover 前必须全部机械动作经 public CLI 自举通过；S08-REVIEW-010 单独排期，不得混入。
- Required control：cutover matrix、migration fail-closed、restart/recovery、Project Acceptance、real Host tests。

## pluginv2 S08 risk entities

### S08-A risk
<!-- proofloop:entity id="PLUGINV2-S08-A-RISK" kind="risk" -->
- `core_state_machine: true` — 跨 v1/vNext route 可能把错误版本送入错误 consumer。
- `public_api_change: true` — Host tool 的显式 route/failure projection 必须稳定。
- `migration: true` — v1 artifact 不得被隐式升级或回退解释。
- `cross_process_behavior: true` — source/dist 与 Host/CLI 必须保持同一分流。
- Required control：schema/version discriminator、paired fixture、bounded Finding、无 silent fallback。

### S08-B risk
<!-- proofloop:entity id="PLUGINV2-S08-B-RISK" kind="risk" -->
- `persistent_state: true` — v2 SPV/Stage Plan Receipt 是执行前机器权威。
- `concurrency: true` — write-once、no-replace 与重复 admission 必须可观测。
- `core_state_machine: true` — admission 前后 Stage 权限边界不可混淆。
- `cross_process_behavior: true` — CLI/Runtime/Host 的 digest binding 必须一致。
- Required control：最终 Plan/Evidence Git boundary 在 fresh SPV 前完成；Runtime-only admission、
  完整 digest tuple、当前 HEAD/clean worktree 校验、fresh SPV、旧 Receipt 不覆盖。

### S08-C risk
<!-- proofloop:entity id="PLUGINV2-S08-C-RISK" kind="risk" -->
- `authorization: true` — Context/dispatch 是 Worker 获得执行范围的权限边界。
- `persistent_state: true` — digest-addressed Context 与 Evidence path 必须可重建。
- `concurrency: true` — Context write-once 与读取时 identity re-check 必须抗竞态。
- `cross_process_behavior: true` — 重启后只能从 Manifest/Receipt/Git 重新投影。
- Required control：root-bound Context、allowed/forbidden scope、TOCTOU closure、未 admission 不 dispatch。

### S08-D risk
<!-- proofloop:entity id="PLUGINV2-S08-D-RISK" kind="risk" -->
- `public_api_change: true` — source/dist/CLI/Host projection 必须同构。
- `persistent_state: true` — Manifest、Evidence、Receipt 的 stale binding 不能被覆盖恢复。
- `migration: true` — legacy/v1 与 vNext 必须显式隔离。
- `cross_process_behavior: true` — parity、真实 filesystem、Git snapshot 和重启恢复共同决定结果。
- Required control：真实入口验证、path/symlink/TOCTOU 反例、digest 比对和 recovery test。

### S08-E risk
<!-- proofloop:entity id="PLUGINV2-S08-E-RISK" kind="risk" -->
- `core_state_machine: true` — Worker 完成后如果没有唯一的 CV/Commit/Integration/Gate/Review
  next state，系统会回到 planning 或重复派发同一 Task。
- `persistent_state: true` — 每个 vNext execution Receipt 必须绑定当前 Manifest/Plan、前序
  Receipt/Context digest 和执行期 snapshot，不能让 legacy reader 静默消费。
- `authorization: true` — planning clean boundary 与 execution scope-bound dirty boundary
  必须分开；脏 diff 不能扩大 Worker 权限，也不能被 clean gate 当成 stale authority。
- `concurrency: true` — recovery/recheck、重复 CV、重复 Commit/Integration 和 stale Context
  必须 write-once/fail-closed。
- Required control：真实 Worker→CV→Commit→Integration→Gate→Review action matrix、v1/vNext
  consumer isolation、dirty boundary、snapshot binding、recovery 和 restart tests。

### HP-012 — SPV/admission 与 Git boundary 顺序
<!-- proofloop:entity id="HP-012-SPV-GIT-BOUNDARY" kind="risk" -->
- Status: `VALIDATED_WITH_RESIDUAL`。
- Why hard：当前 snapshot 使用 Git HEAD；如果在 dirty worktree 上完成 SPV，或在
  `PLAN_READY`/admission 后才提交 Plan/Evidence，Receipt 会绑定旧 HEAD，执行阶段才暴露
  stale mismatch。
- Forbidden shortcuts：SPV 前不检查 clean boundary；admission 后提交相关文件；把
  `PLAN_READY` 当作可忽略 snapshot 变化；因 commit 变化自动跳过 stale 校验；让 Evidence
  initializer 在 admission 后制造 tracked dirty files。
- Minimum acceptable implementation：candidate Plan/input 先由 Runtime compile/validate，
  Runtime 再按 Manifest initialize Evidence；Plan/input/Evidence 完成最终 Git boundary 后，
  clean HEAD 下 fresh SPV；admission 再次校验 HEAD/clean；绑定未变化时 `next/context` 不重复
  SPV；真实变化 fail closed 并重新 fresh SPV。
- Acceptance evidence：dirty tracked/untracked、stale HEAD、clean matching HEAD 和
  post-admission unchanged `DISPATCH_WORKER` regression tests；流程 Skill/Contract/Tech
  Spec 顺序一致。
- Residual risk：如果未来改用 tree/content snapshot digest，必须重新审查 Git boundary
  和 Receipt 迁移规则。

### HP-013 — Receipt writer 的 root-bound filesystem boundary
<!-- proofloop:entity id="HP-013-RECEIPT-WRITER-BOUNDARY" kind="risk" -->
- Status: `VALIDATED_WITH_RESIDUAL`。
- Why hard：path-based ReceiptWriter 存在真实 symlink/TOCTOU 风险；仅靠写前/写后
  `realpath` 检查和 rollback 不能保证写入目标没有在检查后被重定向。Node 当前没有
  `openat2/openat` 的原子 root-containment API。
- Forbidden shortcuts：active vNext 使用 legacy raw-path `writeReceipt`；把 post-write
  检查/rollback 当作写入前 containment；用普通 recursive mkdir；用可覆盖的
  `renameSync(temp, final)`；用 readback-time inode 猜测 writer ownership。
- Minimum acceptable implementation：active vNext 必须使用 root-bound directory
  scaffolding、`O_DIRECTORY|O_NOFOLLOW`、root-fd anchored operations、no-replace final
  install、writer-time Receipt identity、bounded readback/rollback；不支持安全能力时
  在写入前 fail closed。legacy raw writer 只保留为显式 compatibility API，不得服务
  v2 Manifest/Receipt。
- Acceptance evidence：Kernel bounded boundary tests、Runtime bounded admission tests、
  symlink/outside/temp/lock/final-competitor/malformed-successor/identity/rollback
  regression；当前 focused matrix 7 files / 96 tests 通过，build 和 `git diff --check`
  通过。
- Residual risk：用户已接受并记录极端恶意 race——攻击者在最后一次 identity check
  后将已绑定的 root/parent inode 整体移出 trust root；纯 Node API 无法提供 syscall-
  atomic containment。该限制不代表正常流程会生成目录外文档；若未来要求绝对 adversarial
  containment，必须引入 native `openat2`/等价 helper，或在不支持的平台整体 fail closed。

### HP-014 — vNext Stage execution state machine and downstream consumers
<!-- proofloop:entity id="HP-014-VNEXT-EXECUTION-LOOP" kind="risk" -->
- Status: `VALIDATED_WITH_RESIDUAL`。
- Why hard：S08 规划时 Stage Plan admission 只证明执行前边界；Worker 产生 scope 内 dirty diff
  后，Runtime 曾不能可靠地从 `TASK_COMPLETE` 投影到 `RUN_CV`，CV/Commit/Integration/Gate/
  Review 也曾存在 legacy consumer、缺失 snapshot binding 或缺失 recovery discriminator。
  这些问题若回归，会让 Stage 在第一次 Worker 后回退，或把 v2 fact 送入 v1 reader。
- Forbidden shortcuts：再次调用 planning clean gate 阻断合法执行 diff；把 checkbox、progress
  或 Worker narrative 当状态机；用 `implement-task` 伪装 recover-task；让 v2 Receipt 进入
  legacy reconcile；只实现 Worker admission 而声称 Stage execution 已闭环；用 mock/internal
  function 替代真实 Host/Runtime seam。
- Minimum acceptable implementation：admitted S08 必须拥有唯一、可恢复的
  `DISPATCH_WORKER → TASK_COMPLETE → RUN_CV → CV_PASS/CV_REPAIR → SLICE_COMMIT →
  INTEGRATION → STAGE_GATE → STAGE_REVIEW` vNext state/consumer path；每个结果绑定
  Manifest/Plan/Context/前序 Receipt/snapshot；expected dirty boundary 只允许当前 scope；
  stale/duplicate/legacy/missing binding 全部 fail closed。
- Acceptance evidence：真实 Host/Runtime/source/dist/CLI action matrix、Worker→Review
  end-to-end fixture、CV repair/recheck、dirty boundary、snapshot/Manifest binding、v1/vNext
  isolation、recovery/restart 和 no-silent-fallback tests。
- Residual risk：S08 已闭合 vNext downstream consumer 与 Stage execution loop；
  S08-REVIEW-010 的 Runtime Proof `not_applicable` 是独立证明缺口，不推翻 execution state
  machine 验证，但不得据此宣称真实 Runtime Proof 已完成。旧 plugin 保持显式回退，不自动
  迁移旧 Receipt/Manifest。

### HP-015 — executable Runtime Proof bootstrap and Evidence rebind
<!-- proofloop:entity id="HP-015-EXECUTABLE-PROOF-BOOTSTRAP" kind="risk" -->
- Status: `VALIDATED_WITH_RESIDUAL`（2026-08-10 S09 acceptance 闭合：canonical executable Runtime Proof schema/digest/Gate executor、canonical Stage ID parity、pristine Evidence refresh 全部通过 S09-C/S09-D 执行与 Review；Gate Receipt 带 restricted_bootstrap 标记）。
- Why hard：active candidate parser/Materializer 目前只接受 `not_applicable`，而 dispatch 与
  Gate runner 的 step type 还不一致；旧 S08B（现 canonical S10）首次 Manifest 因而能通过
  Mechanical Validator，
  却不能执行真实 CLI proof。Plan/Manifest digest 变化后，initializer 又不会覆盖旧非空
  Evidence skeleton，直接修改会破坏 Runtime ownership 和 binding。
- Forbidden shortcuts：把 all-skipped Gate 当作 S10 证明；Brain/Agent 手写 Manifest、
  `proof_digest` 或 Evidence header；保留两套 Runtime Proof type；覆盖已有 Task Evidence/CV；
  post-admission refresh；无 transaction journal 的多文件“成功”；等待 S10-A 后再修改已
  admitted Manifest。
- Minimum acceptable implementation：S09 统一 candidate/compiler/dispatch/Gate 为 canonical
  `command|service_start|service_stop|probe` closed schema，Runtime 独占 proof digest；增加只允许
  pre-admission pristine skeleton 的 root-bound Evidence refresh，具备全量预检、expected file
  binding、transaction journal、rollback/restart recovery 和 final all-binding validation；同时让
  candidate/compiler/Validator/status/admit 对 canonical `^S\d+$` Stage ID 使用同一规则。
- Acceptance evidence：executable PASS/FAIL、unknown field/type、digest injection/mismatch、S10
  executable requirement、pristine refresh、non-pristine/stale/symlink/competitor/interruption/
  restart regression、旧 `S08B0`/`S08B` label fail-closed；source + built process 一致。S09 的
  一次性 `not_applicable` 必须在 Review
  记录 restricted，不计入 AWI-023/项目验收。
- Residual risk：Node 无跨多文件原子事务；journal + compare-and-swap + rollback 只能保证中断
  可检测、可恢复且不能被报告为成功。未完成 transaction 必须阻断 compile/SPV/admission。
  S10 必须含至少一个非 `not_applicable` executable step（gate-admission 已对非 S09 全
  not_applicable fail closed）；S10 的 all-executable Proof 执行与逐步持久化仍需在 S10 Gate
  中实证。

## Gate

- [x] 每个高风险特性有 hard part 条目（HP-001..015）
- [x] 每个 hard part 有 forbidden shortcuts
- [x] 每个 hard part 有 acceptance evidence
- [x] 每个 hard part 有 minimum acceptable implementation
- [x] 阻断硬点（HP-001/002/003）安排在依赖它的任务之前（S1 前 HP-001；S2 前 HP-002/003 决策）
- [x] HP-014 的 vNext execution loop、dirty boundary、downstream consumers 和 recovery 已通过 S08-E acceptance（S08-REVIEW-010 为独立 Runtime Proof residual）
- [x] HP-015 的 executable Runtime Proof、canonical Stage ID parity 与 Evidence refresh 通过 S09 acceptance（2026-08-10；S10 真实 executable Proof 由 S10 Gate 实证）

## 整改硬点（2026-08-15，Slice 级证明绑定 Phase 1）

### HP-016 — slice 级 currentness 消费改造（next.ts 整本 digest 绑定点）
<!-- proofloop:entity id="PLUGINV2-S12-BINDING-CONTRACT-RISK" kind="risk" -->
- Status: `IDENTIFIED`（实施中为阻塞硬点，必须先于 Task D 验收）。
- Why hard：`next.ts`（2752 行）存在约 20 处整本 plan/manifest digest 绑定点（Worker facts、CV facts、Slice facts、handoff 校验等，已核实）；逐点改为 slice 级当前性且 legacy 路径零变化，最易漏改或误改旧模式。
- Forbidden shortcuts：只改部分绑定点；把 legacy 路径也换成新语义；用整本 digest 相等代替 slice 级 currentness；只测新模式不跑旧模式回归；用 mock 替代真实状态读取。
- Minimum acceptable implementation：`binding-currentness.ts` 提供 `isIntegratedSliceCurrent` 等纯函数；next.ts 全部整本 digest 读取点按 slice 级当前性消费，legacy 分支原样保留；改造前先补 characterization tests 锁定旧行为；validate 对已受理且 current 的 Slice 豁免（FR-023）。
- Acceptance evidence：Case 1/2/5 的 slice currentness 单测 + legacy 路径回归全绿 + 改造点清单逐项核对。
- Residual risk：漏改点只在真实 replan 场景暴露 → Task D 端到端 fixture 兜底。

### HP-017 — 凭证三档版本混链隔离（schema_version 3 + 消费端 fail-closed）
<!-- proofloop:entity id="PLUGINV2-S12-SCHEMA-V3-RISK" kind="risk" -->
- Status: `IDENTIFIED`。
- Why hard：v2 消费端当前无 v3 判别；漏判别会把带 binding 字段的凭证当普通 v2 消费，形成静默混链（先例：v2 凭证曾被 legacy reader 静默消费，memory #33/#44）。
- Forbidden shortcuts：让共享 reader 忽略 binding 字段；只加字段不加判别；v3 沿用 v2 校验、不验证 binding 三字段必填；把混链检测写成可绕过的 warning。
- Minimum acceptable implementation：payload.schema_version 三档（1/2/3）判别 + v2 消费端遇 3 显式 fail-closed（`BINDING.SCHEMA_FUTURE`）；v3 凭证 binding 三字段必填校验；legacy 对 ≠1 整链阻塞保持；同一 Stage 混用两种模式被拒（`BINDING.MODE_MIXED`）。
- Acceptance evidence：v3 进入 v2 消费端被拒测试；v2 进入 legacy 整链阻塞回归；混模式拒绝测试；binding 字段缺失/畸形 fail-closed 测试。
- Residual risk：未来再加 schema_version 4 时需重复同一判别纪律。

### HP-018 — replan 端到端（evidence refresh → fresh SPV → admission → C 重跑）
<!-- proofloop:entity id="PLUGINV2-S12-REPLAN-E2E-RISK" kind="risk" -->
- Status: `IDENTIFIED`。
- Why hard：C replan 后全链依赖顺序：plan/manifest digest 变化 → C 的 evidence 绑定变 stale → 走 refresh 工具（仅合法路径，非空 skeleton 不覆盖）→ 全 Stage fresh SPV → 新 admission → A/B 保持 current、C 重跑。任一步错位都会 fail-closed 误伤 A/B 或把环境问题伪装成回归（先例：流程执行问题 #10 `EVIDENCE_BINDING_MISMATCH` 连坐）。
- Forbidden shortcuts：手工改 Evidence 绑定头；跳过 refresh 直接重跑；把已受理 A/B 的 evidence 一起刷新；复用旧 SPV/admission；把 validate 豁免写成无条件跳过。
- Minimum acceptable implementation：Task D fixture（A/B 集成完成、C replan）走 `refresh-vnext-slice-evidence`（refresh/recover/rollback）+ fresh SPV + 新 admission + validate 豁免（仅 current）→ A/B current、C 重跑；旧模式 Case 6 回归。
- Acceptance evidence：FR-020 Case 1-5 端到端 fixture 测试 + Case 6 回归全绿。
- Residual risk：集成 Slice 的 slice-local replan 由本硬点覆盖；post-admission、未完成 Slice
  的 Task-local/Slice-wide epoch 与 Evidence rotation 由 HP-021 单独阻断和验证。

### HP-019 — 测试基线自包含（fixture 依赖本地遗留文件）
<!-- proofloop:entity id="PLUGINV2-S12-TEST-BASELINE-RISK" kind="risk" -->
- Status: `IDENTIFIED`（Task 0，先于一切行为改造）。
- Why hard：`.proofloop/**` 全 gitignore（git 中 0 个 tracked 文件）；部分 vnext 测试从本地遗留文件复制 fixture（如 `.proofloop/manifests/S04.json`），fresh clone 必红；整改过程中会把环境问题误判为回归（初步实施方案 §8.2 已声明，已核实属实）。
- Forbidden shortcuts：把 `.proofloop` 加进 git；继续依赖本地遗留文件；跳过或改写失败测试掩盖问题；测试写项目真实配置（先例：#13 环境污染）。
- Minimum acceptable implementation：Task 0：测试自生成 fixture（或 tracked 的 fixture 生成器）；测试环境隔离（临时 HOME/配置目录）；fresh clone 后全量测试绿。
- Acceptance evidence：fresh clone 冒烟（rm -rf 本地 .proofloop 后全量测试）全绿；测试不写项目配置。
- Residual risk：历史遗留本地文件的存在会让"本地绿"与"fresh clone 绿"不一致——以 fresh clone 为准。

### HP-020 — candidate binding mode 传播（规划输入到 Manifest）
<!-- proofloop:entity id="PLUGINV2-S13-BINDING-MODE-RISK" kind="risk" -->
- Status: `VALIDATED`（AWI-031 implementation `460ea83`；Materializer/candidate adapter/public compile 的三分支验证已通过）。
- Validated constraints：`binding_mode` 仅允许 kernel 闭集值 `"slice-local"`；省略保持 legacy；Materializer 不将模式渲染进 tasks.md；candidate adapter 与 public compile 不得静默丢弃或降级未知值。
- Accepted solution：active plan contract、Runtime `plan-materializer.ts`/`candidate-input.ts` 与 strict public compile seam 已统一接收并传递 `binding_mode`；既有 Compiler/kernel digest oracle 未复制或改写；source/dist/CLI 回归覆盖 slice-local、legacy、invalid 三分支。
- Why hard：Compiler 已支持直接输入 `binding_mode`，但 active candidate schema/adapter 当前不声明或传播该字段；若只修内部 fixture，public `plan compile` 仍会把 S13 静默编译为 legacy，形成错误但表面有效的 Stage Plan。
- Forbidden shortcuts：直接调用内部 Compiler 绕过 candidate → public CLI；在 tasks.md 或 progress.md 伪造模式事实；把未知模式降级为 legacy；只测 Compiler 而不测 Materializer/adapter/CLI 全链。
- Minimum acceptable implementation：candidate contract 明确可选 `binding_mode`；Materializer 保留并校验闭集；Runtime adapter 传递到 `CompileVNextManifestInput`；public compile 的 slice-local/legacy/unknown 三分支均有 source/dist/CLI 可复核测试。
- Acceptance evidence：S13 candidate input → `plan materialize` → `plan compile` 真实路径输出 slice-local Manifest；缺省 legacy 回归；未知值与字段丢失 fail-closed；不接受仅内部函数 fixture。
- Residual risk：Materializer、source runtime 与 built CLI 版本漂移会重新产生 silent legacy fallback，必须由 parity 测试和 clean boundary 约束。

### HP-021 — graded Replan epoch 与 post-admission Evidence rotation
<!-- proofloop:entity id="HP-021-REPLAN-EPOCH-RISK" kind="risk" -->
- Status：`IDENTIFIED`（永久产品能力已由用户确认；Architecture/Contract 已修订；实现与完整 source/dist/public/restart 验证尚未完成）。
- Standard risk facts：
  - `persistent_state: true` — epoch、Receipt、Evidence 与 mutable projection 必须可从本地持久事实重建，历史事实不得覆盖。
  - `concurrency: true` — Evidence rotation 的 identity/CAS、journal、write-once Receipt 与重复/竞态操作必须 fail-closed。
  - `core_state_machine: true` — Task-local/Slice-wide disposition、epoch currentness 与 Gate/Review/Close 状态转移必须保持唯一且可证明。
  - `cross_process_behavior: true` — source/dist/public CLI、重启恢复和 Runtime consumer 必须对同一 epoch 事实保持一致。
  - `public_api_change: true` — 现有 `plan refresh-evidence`/admission request 的 closed schema 扩展必须保持 public operation set 不变且未知输入 fail-closed。
  - `authorization: true` — current epoch、Stage Plan admission、Context/dispatch 与下游 Receipt 是执行授权边界，不得由 Agent narrative 或 mutable pointer 代替。
  - `irreversible_operation: true` — 旧 Evidence 的 epoch-qualified archive 必须可审计、不可覆盖，并以 journal/rollback 处理部分失败。
- Why hard：当前 Runtime 没有“已接纳 `TASK_COMPLETE`、尚未 CV/Commit/Integration、随后
  Replan”的合法路径；旧 Receipt write-once、Materializer 会重置 candidate projection、
  Evidence refresh 会拒绝 non-pristine 内容，三者必须在不覆盖历史事实的前提下重新组合。
  同一 Stage/Slice 还要区分 Task-local（保留边界未变的此前 Task）与 Slice-wide（此前成果受影响
  时全部重做），并让新的 Stage Gate/Review 只消费当前 epoch。
- Forbidden shortcuts：新增 public CLI/operation；把 impact/epoch 逻辑塞进 Materializer；让
  Agent 自报影响范围或 carry-forward 集合；手工改/覆盖 Receipt 或 Evidence；复用旧 SPV、
  Stage Plan、Gate 或 Review；用 mutable current pointer 冒充当前权威；把当前正在 Replan 的
  Task 当作可继承成果；创建新 Stage 以逃避同一 Slice 的 Replan 语义。
- Minimum acceptable implementation：独立 `replan-impact` 机械比较前后 Task contract 与依赖
  闭包，无法证明时 fail-closed；独立 `replan-epoch` 使用现有 `SPV_PASS`/`STAGE_PLAN` 类型和
  epoch-qualified append-only refs 建立 parent chain；现有 `plan refresh-evidence(mode=replan)`
  以 root-bound、identity/CAS、journal、rollback/restart 规则归档旧 Evidence 并生成当前
  canonical skeleton；Runtime 恢复 bounded mutable projection；next/Worker/CV/Commit/Integration/
  Gate/Review/Close 全部消费 current epoch；legacy/initial path 零行为变化。
- Acceptance evidence：Task-local 与 Slice-wide Case 8/9；此前 Task `TASK_COMPLETE` 保留与
  当前 Task 失效对照；post-admission non-pristine Evidence rotation 正向/失败/中断重启；
  parent epoch mismatch、伪造 disposition、旧 Gate/Review 复用拒绝；source/dist/public CLI
  parity、legacy 回归、fresh SPV/current HEAD/clean boundary 和完整 Gate→Review fixture。
- Human confirmation：required（用户已确认 PRD、Architecture Brief 与 Contract/State Matrix）。
- Deferral approval：不得在 S13 执行中延后；若延期，S13 必须保持 blocked，不得再次派发 Worker。
- Residual risk：Node 多文件事务仍依赖 journal + compare-and-swap；epoch chain 扫描、历史
  Evidence 归档清理和未来 Receipt schema 演进必须保持 append-only/fail-closed，不能用性能优化
  绕过完整 parent/currentness 校验。

### HP-022 — slice-local CV v3 public route 与 current-epoch oracle
<!-- proofloop:entity id="HP-022-SLICE-LOCAL-CV-ROUTE-RISK" kind="risk" -->
- Status：`IDENTIFIED`（永久 slice-local 执行能力；必须在任何 slice-local Stage 的 CV admission 前解决）。
- Standard risk facts：
  - `core_state_machine: true` — Manifest mode、nested CV credential discriminator、Worker tip、CV verdict 与 current epoch 必须形成唯一消费状态。
  - `persistent_state: true` — CV Receipt、Context、Manifest/Plan/Proof Index 和 epoch/path binding 必须可从持久事实重建。
  - `cross_process_behavior: true` — source CLI、built CLI、public dispatcher、shared validator、Runtime consumer 与重启 reader 必须一致。
  - `public_api_change: true` — 现有 `stage admit-cv` operation 的 nested closed schema 扩展必须保持 operation set 不变；outer CLI envelope schema 2 与 nested credential schema 2/3 不得混淆。
  - `authorization: true` — 只有当前 Stage/path-bound epoch、Worker tip、Context 与三层 digest 全部匹配，CV 结果才获得 Receipt 写入授权。
  - `concurrency: true` — 重复/竞态 CV admission、混模式 credential 和重复 Receipt 必须 fail-closed/no-write。
- Why hard：当前 public route detector 只接受 nested schema 2，slice-local credential 必须为 schema 3；
  仅修 route 还不足以保证 `readCurrentEpoch` 的 requested Stage/path binding、独立 disposition
  oracle、Worker tip/Context/Proof Index 和 source/dist/public parity 全部一致。
- Forbidden shortcuts：把 outer CLI schema 2 改成 3；将 v3 credential 降级为 v2；直接调用内部
  CV consumer 绕过 public route；手写 CV Receipt/Context；接受 caller 自报 current epoch 或
  binding digest；只测 source 不测 built/public parity；用 mock/fake CV verdict 替代真实 admission。
- Minimum acceptable implementation：扩展现有 `stage admit-cv` adapter/route，使 nested
  `CV_RESULT.schema_version` 按 Manifest mode 接受 v2/v3；共享 validator 校验三层 binding、
  Worker tip、Context、Proof Index、Stage/path-bound current epoch、snapshot 和 Receipt chain；
  v2 legacy 行为零变化；v3 进入 source/dist/public CLI 后由同一 vNext consumer 受理。
- Acceptance evidence：slice-local v3 正向 CV admission；outer schema 2 + nested schema 3
  parity；v2 在 slice-local、v3 在 legacy、不同 Stage epoch、伪造/过期 Worker tip、三层 digest
  不匹配、混模式与重复 Receipt 的 zero-write；source/dist/public/restart/legacy regression；
  独立 CV oracle 不以 Worker Evidence 代替。
- Human confirmation：required（用户已确认永久 slice-local CV v3 能力与两个 seam 拆分）。
- Deferral approval：不得在 S14 或后续首个 slice-local Stage 执行中延后；若延期，当前 Stage
  必须保持 blocked，不得派发未受理的 CV/repair。
- Residual risk：公共 route 与 nested credential schema 若未来再次演进，必须同步更新 source、
  built artifact、shared validator、consumer 和 parity fixture；不得仅修改单层 detector。

## Gate（整改增补）

- [x] 每个整改高风险特性有 hard part 条目（HP-016..022）
- [x] 每个 hard part 有 forbidden shortcuts
- [x] 每个 hard part 有 acceptance evidence 与 minimum acceptable implementation
- [x] 阻塞硬点排期：HP-019（Task 0）先于 HP-016/017/018（Task A-D）
- [x] HP-016..020 的 risk entities 已登记可引用 marker（PLUGINV2-S12-* / PLUGINV2-S13-*)
- [ ] HP-021/HP-022 的 risk entity、epoch/Evidence rotation/CV route 失败矩阵与 S13 recovery fixture 已登记并通过 Stage Review

### PLUGINV2-S12-STAGE-RISK（risk）
### PLUGINV2-S12-STAGE-RISK（risk）
<!-- proofloop:entity id="PLUGINV2-S12-STAGE-RISK" kind="risk" -->
- `core_state_machine: true` — S12 修改凭证 schema、Manifest binding 字段与 next 状态消费路径，不能破坏既有状态机转移。
- `persistent_state: true` — Receipt/Manifest/Evidence binding 语义变化必须可重建、可审计；旧绑定不得静默解释。
- `migration: true` — schema_version 三档（1/2/3）与 legacy/slice-local 模式必须显式隔离；旧制品不得隐式升级或回退。
- `public_api_change: true` — Manifest binding 字段与 CLI 输出合同变化必须 closed、向后兼容（legacy 无 binding 可读）。
- `cross_process_behavior: true` — source/dist/CLI 对同一输入必须一致。
- `concurrency: false` — 本 Stage 执行保持串行（显式声明，蓝图 Phase 2-5 不做）。
- Required control：bindings.spec 隔离性、schema 三档消费端测试、legacy 回归、source/dist parity。
