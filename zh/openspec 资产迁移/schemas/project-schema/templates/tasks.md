## 非目标提醒

<!-- 明确本次不做什么，防止任务分解时 scope 漂移。 -->

## MVP 建议范围

<!-- 明确最小可交付范围，优先完成哪个切片即可形成闭环。 -->

## 文件范围

<!-- 列出预计会修改的文件或目录。 -->

## 依赖关系

<!-- 列出任务与切片之间的阻塞关系。 -->

## 并行机会

<!-- 列出可并行执行的任务或任务组。 -->

## 任务顺序

<!-- 固定骨架：Setup、Blocking、Slice 1..N、Reconciliation。 -->

### 实施约束

- 进入 `apply` 后，先执行 `test-driven-development` 并遵循 `RED -> GREEN -> REFACTOR`。
- `tasks.md` 只承担范围拆分与进度跟踪，不在此处重复展开完整 TDD 细节。
- 若 change 被分类为 `interactive`，`Blocking` 第一项必须是 `Proof Task`。
- 每个实现切片都必须包含显式 `verifier` gate，执行时必须真正调用对应的 `verifier` 子代理。
- 每个切片的 `verifier` 都必须分别写清校验范围、检查内容和 `PASS/FAIL` gate 条件。

## 1. 准备阶段

<!-- 项目初始化、上下文准备、必要资产同步。 -->

- [ ] 1.1 <task-description>
  - **文件 (Files):** <file-paths>
  - **验证命令 (Verification):** <verification-command>
- [ ] 1.2 <task-description>
  - **文件 (Files):** <file-paths>
  - **验证命令 (Verification):** <verification-command>

## 2. 阻塞项

<!-- 所有切片共享的前置阻塞项；未完成前不得进入后续切片。 -->

- [ ] 2.1 <task-description>
  - **文件 (Files):** <file-paths>
  - **验证命令 (Verification):** <verification-command>

## 3. 切片 1：<slice-name>

### 切片目标

<!-- 说明这个切片完成后，用户或系统能独立获得什么能力。 -->

### 独立验收标准

<!-- 说明该切片单独完成时如何验收，不依赖后续切片。 -->

- [ ] 3.1 [Slice-1] <task-description>
  - **文件 (Files):** <file-paths>
  - **验证命令 (Verification):** <verification-command>
- [ ] 3.2 [P] [Slice-1] <task-description>
  - **文件 (Files):** <file-paths>
  - **验证命令 (Verification):** <verification-command>
- [ ] 3.3 [Slice-1] <Slice 1 verifier>
  - **文件 (Files):** <change-artifacts, Slice 1 implementation, Slice 1 tests, verification results>
  - **验证命令 (Verification):** 独立 `verifier` 子代理校验
  - **校验范围 (Inspection Scope):** <Slice 1 change artifacts + related implementation + related tests + validation results>
  - **PASS/FAIL Gate:** <conditions for pass/fail>

## 4. 切片 2：<slice-name>

### 切片目标

<!-- 说明这个切片完成后，用户或系统能独立获得什么能力。 -->

### 独立验收标准

<!-- 说明该切片单独完成时如何验收，不依赖后续切片。 -->

- [ ] 4.1 [Slice-2] <task-description>
  - **文件 (Files):** <file-paths>
  - **验证命令 (Verification):** <verification-command>
- [ ] 4.2 [Slice-2] <Slice 2 verifier>
  - **文件 (Files):** <change-artifacts, Slice 2 implementation, Slice 2 tests, verification results>
  - **验证命令 (Verification):** 独立 `verifier` 子代理校验
  - **校验范围 (Inspection Scope):** <Slice 2 change artifacts + related implementation + related tests + validation results>
  - **PASS/FAIL Gate:** <conditions for pass/fail>

## N. 更多切片（按需追加）

<!-- 若闭环需要更多能力切片，继续按同样结构追加 `切片 3`、`切片 4` ... `切片 N`。 -->

- 每个新增切片都必须包含：
  - 切片目标
  - 独立验收标准
  - 至少一个实现任务
  - 一个显式 `verifier` 校验任务
- 切片编号必须连续，且前一切片的 `verifier PASS` 后才能进入后一切片。

## 5. 对齐 / 收尾项

<!-- 对齐任务、跨切片治理项、文档、回归、兼容性、观测性等。 -->

- [ ] 5.1 <task-description>
  - **文件 (Files):** <file-paths>
  - **验证命令 (Verification):** <verification-command>

## 就绪门禁

<!-- 进入 apply 前的统一检查。 -->
- [ ] 文件范围已明确
- [ ] 已明确 MVP 建议范围
- [ ] 已单列 Blocking 任务
- [ ] 每个 Slice 都包含切片目标
- [ ] 每个 Slice 都包含独立验收标准
- [ ] 已标出 Parallel Opportunities
- [ ] 任务顺序逻辑连贯
- [ ] 每个实现切片都已显式包含 `verifier` 子代理独立校验任务
- [ ] 每个 `verifier` 校验任务都写清了校验范围与 `PASS/FAIL` 门禁
- [ ] 每个切片的 `verifier` 都必须在进入下一个切片前通过
- [ ] 最后一个切片的 `verifier` 必须在进入 `Reconciliation` 前通过
- [ ] 每步任务都有对应的验证命令
- [ ] 任务条目保留 `1.1 / 1.2` 风格并支持 `[P]` 与 `[Slice-X]` 标签
- [ ] 任务粒度达到“实现者无需再猜”的级别
