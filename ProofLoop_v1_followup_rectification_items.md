# ProofLoop v1 分支继续整改清单

版本：v1-evidence-ledger-follow-up-fixes  
当前状态：`READY_WITH_WARNINGS`  
目标状态：`READY`

---

## 0. 总体结论

v1 分支已经把 Evidence Ledger 主线接入了核心协议，但还没有完全闭环。主要问题不是方向错误，而是“规则已经写进去，固定输出模板、阻塞标准、安装行为和文档一致性还没完全同步”。

已经落地的部分：

- `Evidence Ledger Seed` 已进入 Brain Dispatch Contract。
- `Evidence Ledger` 模板已新增。
- schema 已加入 `evidence-ledger` artifact。
- Executor 已被定义为 execution evidence maintainer。
- Code Verifier 已明确不得只因 tests passed 就 PASS。
- Quality Gate 已加入 Evidence Sufficiency Rule、No Invention Rule 和缺陷分类规则。
- Skill Evidence Rule 已进入 skill usage overlay。
- 安装器已从 skeleton 变成可执行脚本。

仍需继续整改：

1. 安装器默认可能复制 canonical skills，与文档承诺不一致。
2. Worker / Code Verifier 的固定输出模板没有完全承接 Contract Echo、Skill Evidence、Ledger Update。
3. Planning Contract Verifier 的 blocker 列表没有完全接入 Declared Contract Rule。
4. schema 的 `apply.requires` 没有要求 `evidence-ledger`。
5. Brain / README / tech-spec / config 仍有旧流程描述，存在流程漂移。
6. `-InstallGeneralAgent` 参数存在，但仓库没有 `.opencode/agents/general.md`。

---

## 1. P0：修正安装器 canonical skills 默认行为

### 问题

安装文档表达的是默认不安装 `.agents/skills/**`，只有显式参数才处理 canonical skills。但当前 `install-proofloop.ps1` 的逻辑是：如果目标项目缺少 canonical skill，默认安装仍可能把 source repo 的 canonical skill 复制过去。

### 风险

- ProofLoop overlay 安装器会默认安装 canonical OpenSpec / TDD skills。
- 用户以为只安装 overlay，实际改变了 skills 层。
- 后续 canonical skill 与目标环境版本冲突时很难排查。

### 建议整改

将默认行为改成：不管目标是否已有 skill，都默认跳过 canonical skills。

建议逻辑：

```powershell
Write-Host "Checking canonical skills..." -ForegroundColor Cyan
foreach ($skill in $CanonicalSkills) {
  if ($OverwriteCanonicalSkills) {
    Copy-Safe -RelativePath $skill -SourceRoot $RepoRoot -TargetRoot $TargetProjectPath
  } else {
    Write-Warning "Skipped canonical skill by default: $skill"
  }
}
```

如需支持“目标缺失时安装 canonical skills”，新增独立参数：

```powershell
[switch]$InstallCanonicalSkills
```

不要让 `-OverwriteCanonicalSkills` 同时承担“覆盖”和“安装缺失 skills”的含义。

### 验收标准

- 默认安装不会复制任何 `.agents/skills/**`。
- 只有显式参数才会复制 canonical skills。
- 安装脚本、`install/README.md`、`install/manual-install.md` 三者行为一致。
- 安装输出明确提示 canonical skills 被跳过。

---

## 2. P0：补齐 Worker Completion Receipt 模板

### 问题

`worker.md` 职责里要求返回 Contract Echo 和 Skill Evidence，但 Completion Receipt 模板本身没有这两个字段，也没有 Ledger Update 字段。

### 风险

- Worker 可能口头遵守，但输出缺字段。
- Executor 无法稳定 append Skill Evidence 到 Evidence Ledger。
- Code Verifier 无法机械判断 required skill 是否真的产生证据。
- Contract Echo Rule 落不到 receipt 层。

### 建议整改

将 Worker Completion Receipt 模板改为：

```text
Implementation finished | Implementation blocked | Implementation failed | Evidence backfilled

Task:
Slice:

Contract Echo:
- accepted:
- satisfied:
- not satisfied:
- conflicted:

Skills used:

Skill Evidence:
- required skills:
- evidence:
- deviation / not applicable reason:

Acceptance Criteria Coverage:
- AC:
- status:
- evidence:

TDD Evidence:
- RED:
- GREEN:
- REFACTOR:
- deviation / not applicable reason:

What changed:
Files changed:
Commands run:
Verification result:
Acceptance evidence:

CodeGraph Evidence:
- status checked:
- stale banner encountered:
- anchors used:
- impact notes:
- fallback direct reads:

Git Boundary:
- commit created: no
- expected next boundary: task-diff-snapshot

Ledger Update:
- assigned section:
- receipt ready for executor append: yes/no

Stop conditions encountered:
Upgrade required:
- yes/no
- reason:

Residual risk:
```

### 验收标准

- Worker receipt 固定包含 Contract Echo。
- Worker receipt 固定包含 Skill Evidence。
- Worker receipt 固定包含 Ledger Update。
- TDD Evidence 不再是唯一 skill evidence 位置。
- Executor 可以直接将 receipt summary append 到 Evidence Ledger。

---

## 3. P0：补齐 Code Verifier 输出模板

### 问题

`code-verifier.md` 已经要求不得只因 tests passed 就 PASS，也要求 missing evidence 归类为 EVIDENCE DEFECT。但输出模板没有强制呈现 Contract Echo Check、Skill Evidence Check、Evidence Sufficiency、Ledger Update。

### 风险

- Evidence Sufficiency Rule 可能再次退化成测试绿灯判断。
- Implementation Reviewer 无法从固定字段读取 verifier 的证据判断。
- Executor append verifier result 到 ledger 时缺少结构化字段。

### 建议整改

将 Code Verifier 输出模板改为：

```text
Slice verification passed | Slice verification failed | Slice verification blocked

Category:
Severity:

Slice:
Covered Tasks:

Contract Echo Check:
- received:
- evidence present:
- evidence missing:
- conflicted:

AC Coverage:
Evidence Packet Check:

Evidence Sufficiency:
- declared Verification Method executed:
- Expected Evidence present:
- command evidence sufficient:
- missing evidence:
- evidence weakness:

Skill Evidence Check:
- Required Skills:
- Required Review Skills:
- evidence present:
- missing:

Task Snapshot Receipt Check:
CodeGraph Impact Check:
Required Review Skills:
Boundary / Scope Check:
TDD Evidence:
Command Evidence:

Ledger Check:
- path:
- assigned slice section:
- read successfully:
- unrelated sections ignored: yes/no

Ledger Update:
- verifier result ready for executor append: yes/no

Findings:
- BLOCKER:
- WARNING:
- NOTE:

Minimal next action:
- proceed to slice-output commit
- repair implementation
- backfill evidence
- return to Propose
- return to Brain
```

### 验收标准

- Code Verifier 输出能看出它是否核对 Contract Echo。
- Code Verifier 输出能看出 Skill Evidence 是否存在。
- Code Verifier 输出能看出 Expected Evidence 是否足够。
- Missing evidence 明确归类为 EVIDENCE DEFECT。
- Ledger read / append handoff 可机械追踪。

---

## 4. P1：把 Declared Contract Rule 接入 Planning Contract Verifier blocker

### 问题

Planning Contract Verifier 已经说明要校验 declared contract 是否映射到 executable acceptance、Verification Method、Expected Evidence 或 approved deferral，但 `Block only when` 列表没有把这条作为明确 blocker。

### 风险

- Declared Contract Rule 只存在于说明文字中。
- Verifier 可能仍按旧 blocker 只检查 AC、scope、Verification Method、Stop Conditions。
- design / spec / tasks 内部冲突可能漏过 planning gate。

### 建议整改

在 `.opencode/agents/planning-contract-verifier.md` 的 `Block only when` 增加：

```text
- A binding contract item is declared in Brain Dispatch Contract, proposal, design, specs, tasks, or Slice Contract but is not mapped to executable acceptance, Verification Method, Expected Evidence, approved deferral, or explicitly marked non-binding.
- Planning artifacts contain an unresolved internal conflict that would force Executor, Worker, Code Verifier, or Implementation Reviewer to guess.
- Evidence Ledger Brain Dispatch Snapshot is missing or inconsistent with Brain Dispatch Contract.
- Evidence Ledger AC Mapping Summary is missing required Brain acceptance criteria.
```

### 验收标准

- Binding contract item 不会停留在 prose 里无人验证。
- 设计 / 规范 / 任务内部冲突会在 planning 阶段阻塞。
- Planning Contract Verifier 的 blocker 与 Declared Contract Rule 一致。
- 下游 Executor / Worker 不需要猜。

---

## 5. P1：让 apply 阶段要求 Evidence Ledger

### 问题

schema 已经新增 `evidence-ledger` artifact，但 `apply.requires` 仍然只有 `tasks`，没有要求 `evidence-ledger`。

### 风险

- OpenSpec Change 可能进入 Executor 阶段，但 ledger 没有生成。
- Executor 无法 append execution evidence。
- Code Verifier / Implementation Reviewer 没有稳定证据入口。
- Evidence Ledger 从默认必备退化成可有可无。

### 建议整改

短期修改 schema：

```yaml
apply:
  requires:
    - tasks
    - evidence-ledger
```

同时在 `executor.md` 增加 preflight 规则：

```text
If Route is openspec-change and Evidence Ledger path is missing or unreadable,
return Execution blocked with PROTOCOL DEFECT.
```

### 验收标准

- OpenSpec Change 默认必须有 `proofloop/evidence-ledger.md`。
- Executor 在 ledger 缺失时阻塞，而不是继续执行。
- Code Verifier dispatch 必须包含 Evidence Ledger path 和 assigned slice section。
- Implementation Reviewer stage review 必须引用 ledger。

---

## 6. P1：修正 Brain / README / tech-spec / config 的流程漂移

### 问题

以下文件仍包含旧流程描述或不完整流程：

```text
.opencode/agents/brain.md
README.md
tech-spec.md
openspec/config.yaml.example
```

典型问题：

- `brain.md` OpenSpec Change 简图跳过 Worker / task-diff-snapshot。
- README 没体现 Evidence Ledger Seed / materialize / ledger evidence。
- tech-spec 仍是旧 v3.3 描述。
- config example 的 rules 没体现 Evidence Ledger。

### 建议整改

#### 6.1 修改 `brain.md`

将 OpenSpec Change 简图改成：

```text
OpenSpec Change:
Brain -> Evidence Ledger Seed
      -> Propose
      -> Planning Contract Verifier
      -> Executor
      -> Implementation Reviewer
      -> Brain archive authorization
      -> Implementation Reviewer archive execution
      -> Committer archive-output if needed
```

并加注：

```text
Worker / task-diff-snapshot / Code Verifier / slice-output are Executor-owned apply-stage internals.
Brain does not directly orchestrate Worker or Code Verifier.
```

#### 6.2 修改 README

README 只保留概览：

```text
OpenSpec Change:
Brain creates Evidence Ledger Seed.
Propose materializes the ledger.
Executor maintains execution evidence.
Code Verifier checks assigned slice evidence.
Implementation Reviewer performs stage acceptance from the full ledger.
```

#### 6.3 修改 tech-spec.md

改成当前版本摘要：

```text
ProofLoop Technical Spec v1 Evidence Ledger Edition
```

补充：

```text
Evidence Ledger is the delivery evidence spine for OpenSpec Change.
```

#### 6.4 修改 openspec/config.yaml.example

rules 增加：

```yaml
- OpenSpec Change uses Evidence Ledger Seed and proofloop/evidence-ledger.md as the evidence transport index.
- Executor maintains execution evidence in the Evidence Ledger.
- Code Verifier must not pass solely because tests are green.
- Evidence Ledger does not introduce new requirements.
```

### 验收标准

- 以上文件对 OpenSpec Change 的描述不再互相冲突。
- README / tech-spec / config 不再遗漏 Evidence Ledger。
- Brain 不再写出跳过 Worker 的误导性流程。
- Executor 内部流程只由 Executor 文档和 executor-dispatch-packets 负责。

---

## 7. P2：处理 `-InstallGeneralAgent` 半落地问题

### 问题

安装器和文档支持 `-InstallGeneralAgent`，并尝试复制 `.opencode/agents/general.md`，但 v1 分支目前没有该文件。

### 风险

- 用户传 `-InstallGeneralAgent` 时只得到 source not found warning。
- 安装器参数看似可用，实际不可用。
- Direct Task self-contained mode 半落地。

### 方案 A：删除该参数

如果当前决定依赖 host runtime 的 `general`，则删除：

```text
-InstallGeneralAgent
```

并从 install README / manual-install 中删除 optional general agent。

补充说明：

```text
ProofLoop does not ship a general agent.
Direct Task uses the host runtime's general agent constrained by Brain Dispatch Contract and Completion Receipt format.
```

### 方案 B：新增 `.opencode/agents/general.md`

如果希望提供 self-contained Direct Task executor，则新增：

```text
.opencode/agents/general.md
```

短期推荐方案 A，减少默认 surface area。若用户明确希望 ProofLoop 自包含，再采用方案 B。

### 验收标准

- `-InstallGeneralAgent` 不再指向不存在的文件。
- 文档与实际文件一致。
- Direct Task 来源明确：host runtime general 或 ProofLoop-owned general。

---

## 8. P2：Implementation Reviewer 输出补充 Ledger 字段

### 问题

Implementation Reviewer 已经读取 full Evidence Ledger 做 stage acceptance，但输出模板没有体现 ledger 引用或写回字段。

### 建议整改

在 `.opencode/agents/implementation-reviewer.md` 输出模板增加：

```text
Evidence Ledger:
- path:
- Brain Dispatch Snapshot checked:
- slice verifier results checked:
- stage review section updated:
- archive section updated:
```

### 验收标准

- Stage Review 结果能稳定 append 到 Evidence Ledger。
- Brain 能根据 Implementation Reviewer 输出找到 ledger section。
- Archive readiness 有落盘索引。

---

## 9. P2：Evidence Ledger 模板补充 Contract Echo 字段

### 问题

Evidence Ledger 模板的 Worker Completion Receipt section 有 skill evidence、acceptance evidence，但没有 Contract Echo。Slice Verification section 也缺少 Skill Evidence Check。

### 建议整改

在 `templates/evidence-ledger.md` 的 Worker Completion Receipt 下补：

```text
Contract Echo:
- accepted:
- satisfied:
- not satisfied:
- conflicted:
```

在 Slice Verification 下补：

```text
Contract Echo Check:
- received:
- evidence present:
- evidence missing:
- conflicted:

Skill Evidence Check:
- present:
- missing:
```

### 验收标准

- Ledger 模板与 Worker / Code Verifier 输出模板一致。
- Contract Echo 可落盘。
- Skill Evidence Check 可落盘。

---

## 10. 推荐整改顺序

```text
P0-1 修安装器 canonical skills 默认行为
P0-2 补 Worker receipt 模板
P0-3 补 Code Verifier output 模板

P1-1 Planning Contract Verifier blocker 接入 Declared Contract Rule
P1-2 apply.requires 加 evidence-ledger，或 Executor preflight 阻塞缺失 ledger
P1-3 修正 Brain / README / tech-spec / config 流程漂移

P2-1 处理 -InstallGeneralAgent 半落地
P2-2 Implementation Reviewer 输出补 Ledger 字段
P2-3 Evidence Ledger 模板补 Contract Echo / Skill Evidence Check
```

---

## 11. 最终验收标准

整改完成后，应满足：

1. 默认安装不会复制 canonical skills。
2. Worker receipt 固定包含 Contract Echo、Skill Evidence、Ledger Update。
3. Code Verifier output 固定包含 Contract Echo Check、Skill Evidence Check、Evidence Sufficiency、Ledger Update。
4. Planning Contract Verifier blocker 明确覆盖 binding contract unmapped / unresolved conflict。
5. OpenSpec Change apply 阶段必须有 Evidence Ledger，缺失则 Executor blocked。
6. Brain / README / tech-spec / config 对 Evidence Ledger 流程描述一致。
7. `-InstallGeneralAgent` 不再指向不存在的 general.md。
8. Implementation Reviewer 输出能引用 / 更新 Evidence Ledger。
9. Evidence Ledger 模板能承载 Contract Echo 和 Skill Evidence Check。
10. 不新增任何项目特定规则。

---

## 12. 最终判断

当前 v1 分支不是方向错误，而是 Evidence Ledger 方案半落地。

核心协议已经进入仓库，但还需要把协议落实到：

```text
- 固定输出模板
- blocker 标准
- apply preflight
- 安装器默认行为
- 用户 / 维护者文档一致性
```

修完上述内容后，v1 可以从：

```text
READY_WITH_WARNINGS
```

提升为：

```text
READY
```
