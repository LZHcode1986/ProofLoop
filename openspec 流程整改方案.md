# OpenSpec 流程整改方案

## 1. 目的

本文只讨论 OpenSpec 流程如何整改，目标是避免以后再出现这类假完成：

- proposal / design / tasks 都写了
- tasks 已打勾
- 局部测试全绿
- 但真实入口没闭环，用户实际玩不通

本文不展开游戏侧修复，游戏问题与实现方案另见根目录 `游戏选当问题调查报告.md`。

## 2. 本次整改的总原则

这次整改不做“继续加门、继续加模板、继续加检查表”。

只做 4 个方向的收缩式改造：

1. 正式规划门禁只保留两道，不再保留多轮 coverage gate
2. 不拆两套 `tasks.md` 模板，保留一套模板并加条件分支
3. 把交互类 change 从附加提醒升级成 `apply` 分支流程
4. 把“证据链是否闭合”的判定前移到实施前和 `apply` 收尾，不等到 archive

## 3. 新流程总览

整改后的默认流程：

1. 写 `proposal.md`
2. 做 `proofability check`
3. 写 `design.md`
4. 写 `specs/*` 与 `tasks.md`
5. 做 `tasks readiness check`
6. 进入 `apply`
7. 若为交互类 change，先走 `proof-first apply`
8. `apply` 收尾时完成 `implementation done check`
9. 用户自行验证通过后再 `archive`

对应地，正式门禁只保留这 3 个：

1. `proofability check`
2. `tasks readiness check`
3. `implementation done check`

archive 不再承担任何质量校验职责，只负责收口。

## 4. 对现有方案的收缩结论

### 4.1 不再保留 `proposal coverage check` 和 `design coverage check`

原因：

- 这两道门和 `tasks` 阶段的 readiness / traceability 高度重复
- 会把 propose 变成“写完一层就停下来验一次”的重流程
- 对小 change、非交互类 change 来说成本过高

调整后：

- `proposal` 写完后，只做 `proofability check`
- `design` 不再单独做正式 coverage gate
- `specs/*` 和 `tasks.md` 写完后，统一做 `tasks readiness check`

含义：

- proposal / design 仍然要写完整
- 但 proposal / design 的完整性检查不再作为独立阻塞阶段
- 真正的阻塞只保留在“能否被证明”与“tasks 是否已经可执行”这两处

### 4.2 不拆两套 `tasks.md` 模板

原因：

- 两套模板容易漂移
- 维护成本高
- 很多 change 实际处在边界区，硬分模板会增加判断成本

调整后：

- 保留一套统一模板
- 模板结构改成更中性的五段
- 是否进入交互类 proof-first，由 change classification 决定

推荐统一结构：

- `Setup`
- `Blocking`
- `Slice A`
- `Slice B`
- `Reconciliation`

其中：

- 非交互类 change：`Blocking` 放共享前置项
- 交互类 change：`Blocking` 的第一项必须是 `Proof Task`

### 4.3 交互类 change 升级为 `apply` 分支流程

这一步保留，但做最小侵入。

不改成“交互类从 propose 到 archive 全流程完全分叉”，只改一件事：

- 在 `apply` 阶段分支

具体表现为：

- `standard` change：
  - `tasks ready -> apply`
- `interactive` change：
  - `tasks ready -> proof-first apply`

这里的 `proof-first apply` 不要求 propose 阶段再多一轮大审查，只要求：

- `tasks.md` 已经写明 proof task
- `apply` 开始时必须先建立并验证 proof 骨架
- proof task 未完成前，不得进入后续实现切片

### 4.4 “证据链已闭合”不等到 archive 才判

这点按你的意见调整。

证据链分两次判：

1. `tasks readiness check`
   - 判“证据链是否已被写进 tasks，且顺序正确”
2. `implementation done check`
   - 判“证据链是否真的已在 `apply` 收尾时执行闭合”

archive 只做：

- delta spec 同步与否提示
- 归档目录与命名安全
- 主 spec 正规化收口

## 5. 三个正式门禁怎么定义

### 5.1 `proofability check`

时机：

- `proposal.md` 写完后
- 进入 `design.md` 前

只检查 5 件事：

1. 最小闭环的真实入口是什么
2. 用户真实操作顺序是什么
3. authority 单源在哪里
4. 哪些证据明确不算完成
5. 最终用什么验证方式证明闭环成立

通过前：

- 不允许继续写 design

不检查的内容：

- 不做逐条 requirement coverage 表
- 不做设计级细节穷举

### 5.2 `tasks readiness check`

时机：

- `specs/*` 与 `tasks.md` 写完后
- 进入 `apply` 前

只检查 4 件事：

1. `tasks.md` 是否已经把最小闭环拆成可执行步骤
2. 每个关键任务是否有文件范围和验证命令
3. 若是交互类 change，proof task 是否已经被前置
4. proposal / design / specs / tasks 是否还在描述同一条闭环

通过前：

- 不允许进入 apply

### 5.3 `implementation done check`

时机：

- `apply` 阶段任务完成后
- 作为 `apply` 的收尾动作执行
- 用户自己做最终校验前

只检查 3 件事：

1. tasks 里的验证命令是否实际跑过
2. 若是交互类 change，是否已经有真实入口级证明，而不是内部直调伪验证
3. 代码、任务、验证结果是否一致

通过前：

- `apply` 不应宣告完成
- 不建议进入 archive

## 6. `tasks.md` 模板整改方案

### 6.1 模板结构调整

把当前结构：

- `Setup`
- `Foundational / Blocking`
- `Slice A`
- `Slice B`
- `Polish / Cross-Cutting`

改成：

- `Setup`
- `Blocking`
- `Slice A`
- `Slice B`
- `Reconciliation`

调整原因：

- `Foundational / Blocking` 太偏“共享前置项”语义
- `Blocking` 更适合同时容纳 proof-first 任务
- `Polish / Cross-Cutting` 容易被做成收尾润色
- `Reconciliation` 更明确是对齐代码、任务、验证与文档

### 6.2 模板正文怎么改

在模板说明里明确：

- 所有 change 都必须按最小闭环拆任务
- 所有任务都必须有文件范围和验证命令
- 若 change 被分类为 `interactive`，`Blocking` 第一项必须是 `Proof Task`
- 若 change 被分类为 `interactive`，必须拆出真实交互验收，不能只靠逻辑注入测试
- `Reconciliation` 负责收拢验证结果、文档同步、跨切片对齐，不再叫 polish

### 6.3 模板不做的事

不新增第二套模板。  
不为交互类 change 额外复制一份完整结构。  
不把 `tasks.md` 变成第二份 design 文档。

## 7. “交互类 change 分支流程”怎么落地

### 7.1 分类规则要收窄

分类只保留两类：

- `standard`
- `interactive`

`interactive` 只在命中以下风险时触发：

- 输入路径
- HUD / Overlay / 反馈闭环
- 坐标、命中、相机、交互判定
- “可启动但不可玩”的运行时风险

不要把一般 UI 文案、静态样式、纯数据结构改动都归为交互类。

### 7.2 propose 阶段怎么体现

在 propose 阶段，不新增单独 artifact，也不新增重门禁。

只做两件事：

1. 分类当前 change 是 `standard` 还是 `interactive`
2. 若是 `interactive`，在 `proposal` / `design` / `tasks` 中补齐必要写作项

这些必要项包括：

- 真实入口
- 输入所有权
- authority 单源
- 假阳性定义
- proof task 入口

### 7.3 apply 阶段怎么体现

`apply` 的动态指令必须按 change 类型分支：

- `standard`
  - 正常按 tasks 顺序推进
- `interactive`
  - 先执行 `Blocking` 里的 proof task
  - proof task 通过前，不得推进后续切片

这就是“交互类 change 升级成分支流程”的真正含义。

### 7.4 为什么不会伤到非交互类 change

因为普通 change：

- 不需要 proof-first
- 不需要真实入口交互证明
- 不需要输入所有权与坐标边界写作项
- 不需要假阳性拦截任务

所以只要分类规则收窄，非交互类 change 会更轻，不会更重。

## 8. 各份文档怎么整改

下面只列真正承载规范与流程逻辑的文档。不改 `openspec/CHANGE-WORKING-AGREEMENT.md`，因为它是说明文档，不是规范文档。

### 8.1 `openspec/config.yaml`

当前问题：

- `interaction` 规则写得较多，但还停留在“写作要求”
- 没有把 `standard / interactive` 明确提炼成统一分支概念

整改目标：

- 保留 classification 能力
- 收窄交互类判定条件
- 明确 `interactive` 的目标不是“多写文档”，而是“进入 proof-first apply”

具体改法：

1. 在 `interaction.classification` 中明确只分 `standard` / `interactive`
2. 收窄 `interactive` 触发条件，避免泛化到普通 UI 改动
3. 在 `tasks` 或 `implementation` 规则中明确：
   - `interactive` change 的 `Blocking` 第一项必须是 `Proof Task`
4. 删除或收缩那些只会重复出现在 `QUALITY-GATE.md` 与模板中的交互类表述

### 8.2 `openspec/schemas/project-schema/schema.yaml`

当前问题：

- 还在描述旧流程：`proposal -> design -> specs -> tasks -> apply`
- `tasks` 结构仍写死旧分段
- `apply` instruction 还没有按 change 类型分支

整改目标：

- 把 schema 的阻塞逻辑改成新流程
- 让 CLI / skill 拿到的 instruction 天然体现 proof-first

具体改法：

1. `proposal.instruction`
   - 明确 `proposal` 完成后必须做 `proofability check`
   - 不再提单独 coverage gate
2. `design.instruction`
   - 保留“覆盖 proposal 非延期项”
   - 不再暗示单独的 design coverage gate
3. `tasks.instruction`
   - 把结构改成 `Setup -> Blocking -> Slice A -> Slice B -> Reconciliation`
   - 明确若为 `interactive`，`Blocking` 第一项必须是 `Proof Task`
4. `apply.instruction`
   - 新增动态分支语义：
     - `standard`: 按 tasks 推进
     - `interactive`: 先 proof task，再实现
5. 若 schema 支持 gate 文本或 metadata，也应显式加入：
   - `proofability check`
   - `tasks readiness check`
   - `implementation done check`

### 8.3 `openspec/schemas/project-schema/templates/proposal.md`

当前问题：

- proposal 目前更偏范围、风险、验收、影响对象
- 对“真实入口下的闭环证明”还不够直接

整改目标：

- proposal 不加厚，但要能支持 `proofability check`

具体改法：

1. 在 proposal 模板中明确要求写出：
   - 最小闭环的真实入口
   - 用户操作顺序
   - 完成证据
   - 失败证据
2. 对 `interactive` change，要求：
   - “可启动但不可玩=失败”必须出现在验收标准
3. 不新增 coverage table 章节
4. 不把 proposal 写成 design 预演

### 8.4 `openspec/schemas/project-schema/templates/design.md`

当前问题：

- design 已有权威边界、状态迁移、接口影响等要求
- 但没有把 proofability 所需的设计落点写得够明确

整改目标：

- 让 design 成为 proofability 的落点文档，而不是单独再加 design coverage gate

具体改法：

1. 对所有 change，保留：
   - authority 边界
   - 状态迁移
   - API / contract 影响
2. 对 `interactive` change，追加明确要求：
   - 输入所有权
   - 状态写入边界
   - UI 读取边界
   - proof 方法
   - 假阳性定义
3. 不增加单独“design coverage checklist”章节

### 8.5 `openspec/schemas/project-schema/templates/tasks.md`

这是本次整改的重点模板。

具体改法：

1. 标题段落中的固定顺序改为：
   - `Setup`
   - `Blocking`
   - `Slice A`
   - `Slice B`
   - `Reconciliation`
2. `实施约束` 中补充：
   - `interactive` change 的 `Blocking` 第一项必须是 `Proof Task`
3. `交互类附加拆分` 改成更短的条件化规则：
   - 拆出真实交互验收
   - 拆出假阳性拦截
   - 若涉及坐标/命中，拆出对应验证
4. `就绪门禁` 改名为 `tasks readiness check`
5. readiness 内容只保留必要项：
   - 最小闭环已拆成任务
   - 每个关键任务有验证命令
   - `interactive` change 已前置 proof task
   - 文档与任务仍对齐同一条闭环
6. 删除旧措辞：
   - `Foundational / Blocking`
   - `Polish / Cross-Cutting`

### 8.6 `openspec/QUALITY-GATE.md`

当前问题：

- 现在的门禁内容偏多、偏散
- 同时承载 proposal、design、tasks、archive 多阶段语义
- 交互类附加检查重复较多

整改目标：

- 把它收敛成 propose 阶段后半段与 `apply` 阶段使用的 gate 文档
- 不再承担 archive 相关职责

具体改法：

1. 结构压缩成 3 组：
   - `Proofability Check`
   - `Tasks Readiness Check`
   - `Implementation Done Check`
2. 删除“proposal coverage / design coverage”式重复问法
3. 把交互类检查收束到：
   - 是否存在真实入口定义
   - proof 是否不是内部直调伪验证
   - 是否把“可启动但不可玩=失败”写入验收
4. 删除 `Archive Safety` 相关 gate 语义

### 8.7 Archive 收口规则

当前问题：

- 如果 archive checklist 还承担“发现没做完”的职责，就会和你的使用时机冲突

整改目标：

- 让 archive 规则只做归档安全收口
- 不包含任何质量校验或“是否已经做完验证”的判断

具体改法：

1. 删除“首次检查证据链是否闭合”的语义
2. 只保留：
   - delta spec 是否需要同步
   - 归档目录和命名是否安全
   - 主 spec 是否可安全正规化
3. 明确 archive 不是最终质量发现阶段

## 9. 各个 skills 怎么整改

本次整改不仅改 OpenSpec 文档，还必须改 skill，否则流程仍会被旧 skill 拉回旧逻辑。

### 9.1 `.agents/skills/openspec-propose/SKILL.md`

当前问题：

- 还强制：
  - `proposal coverage check`
  - `design coverage check`
  - `final traceability review`
  - `final readiness gate`
- 这和新的轻量流程冲突

整改目标：

- skill 必须改成“两道规划门 + 一道实施前 readiness”的新逻辑

具体改法：

1. 把 progress checklist 改成：
   - source decomposition complete
   - `proposal.md` drafted
   - `proofability check` complete
   - `design.md` drafted
   - `specs/*` drafted
   - `tasks.md` drafted
   - `tasks readiness check` complete
2. 删除：
   - proposal coverage check milestone
   - design coverage check milestone
   - final traceability review milestone
   - final readiness gate milestone
3. 在 artifact workflow 中改成：
   - `proposal.md` 后立即执行 `proofability check`
   - `design.md` 后直接进入 `specs/*` 与 `tasks.md`
   - `tasks.md` 后执行 `tasks readiness check`
4. 把 `tasks.md` 的固定结构说明改成：
   - `Setup -> Blocking -> Slice A -> Slice B -> Reconciliation`
5. 若分类为 `interactive`，要求 skill 在生成 tasks 时前置 `Proof Task`

### 9.2 `.agents/skills/openspec-apply-change/SKILL.md`

这是本次必须改的 skill。

当前问题：

- 还只是“读 apply instruction，然后按 tasks 推进”
- 没有按 `standard / interactive` 分支

整改目标：

- 把交互类 change 的 proof-first 真实落到 apply
- 让 `implementation done check` 成为 `apply` 的收尾动作，而不是额外 workflow

具体改法：

1. 在读取 apply instruction 后，显式识别 change 类型
2. 若为 `standard`
   - 正常按 tasks 推进
3. 若为 `interactive`
   - 先执行 `Blocking` 中的 proof task
   - proof task 未完成前，不得推进任何实现切片
4. 在完成所有任务后，新增一次 `implementation done check`
5. 输出中明确区分：
   - proof task 已完成
   - implementation tasks 已完成

### 9.3 `.agents/skills/openspec-archive-change/SKILL.md`

当前问题：

- 归档 skill 现在还偏“任务数检查 + spec sync 提示”
- 没明确 archive 不是质量发现阶段

整改目标：

- 保持 archive skill 轻量
- 不让它重新承担 proof / readiness 判定
- 不在 archive skill 中引入任何“implementation done check”确认步骤

具体改法：

1. 保留：
   - artifact completion 检查
   - task completion 检查
   - delta spec sync assessment
   - archive move
2. 在提示文案中明确：
   - archive 假定实施与用户校验已完成
3. 不在 archive skill 中新增新的质量 gate

### 9.4 可能联动的其他 skills

如果仓库里还有会自动生成 propose / tasks / apply 指令的 OpenSpec 相关 skill，也要同步调整同样的逻辑：

- 删除 proposal/design 多轮 coverage gate
- 同步新 `tasks` 结构
- 同步 `interactive` 的 proof-first apply 分支

## 10. 推荐的实际改造顺序

为了降低冲击，建议按下面顺序改：

1. 先改 `openspec/QUALITY-GATE.md`
   - 先把门禁概念收敛成 3 个检查
2. 再改 `openspec/schemas/project-schema/templates/tasks.md`
   - 先把任务结构改成新五段
3. 再改 `openspec/schemas/project-schema/schema.yaml`
   - 让 schema 指令与新门禁、新结构对齐
4. 再改 `openspec/config.yaml`
   - 收窄 `interactive` 分类规则
5. 再改 `.agents/skills/openspec-propose/SKILL.md`
   - 防止 propose 仍按旧 coverage 流程工作
6. 再改 `.agents/skills/openspec-apply-change/SKILL.md`
   - 真正落下 proof-first apply
7. 最后改 `.agents/skills/openspec-archive-change/SKILL.md`
   - 收口归档话术与检查职责

这个顺序的好处是：

- 先改规范，再改模板，再改 skill
- 不会出现 skill 已切新逻辑，但底层文档还在说旧逻辑

## 11. 最终落地后的默认认知

整改完成后，OpenSpec 的默认认知应变成：

- proposal 不是为了覆盖率打表，而是为了定义可证明的闭环
- design 不是为了再过一轮 coverage，而是为了把 proofability 落到实现边界
- tasks 不是普通待办列表，而是闭环实现与验证的执行骨架
- 交互类 change 不是“多写点附加说明”，而是 `apply` 时必须先 proof
- `implementation done check` 是 `apply` 的收尾动作，不是独立 workflow
- archive 不是发现问题的阶段，也不是校验阶段，只是安全收口阶段

## 12. 最终结论

这次整改不需要把 OpenSpec 做得更厚。

真正要改的只有 4 件事：

1. 删掉 proposal / design 的重复 coverage gate
2. 保留一套 `tasks.md` 模板，但把结构改成 `Setup -> Blocking -> Slice -> Reconciliation`
3. 把交互类 change 升级成 `apply` 内部的 proof-first 分支
4. 把证据链闭合前移到 `tasks readiness` 和 `implementation done`，不等 archive

按这个方向改，流程会比现在更轻，但也更能拦住“文档和测试都像完成了，真实入口却没闭环”的问题。
