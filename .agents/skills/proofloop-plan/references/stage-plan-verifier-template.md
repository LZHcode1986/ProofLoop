# Stage Plan Verifier Dispatch Template

本模板供 `proofloop-plan` 为 Brain 直接调度 `stage-plan-verifier` 使用。

## 调度包

```yaml
target_agent: stage-plan-verifier
caller: brain
skill: proofloop-plan
mode: vnext
stage_id: <stage-id>
project_root: <canonical-trust-root>
candidate_plan_path: delivery/stages/<stage-id>/tasks.md
candidate_manifest_path: .proofloop/manifests/<stage-id>.json
evidence_dir: delivery/stages/<stage-id>/evidence
plan_digest: <sha256>
manifest_digest: <sha256>
snapshot_digest: <40-hex current Git HEAD>
authority_refs: []
reference_index_digest: <sha256>
proof_index_digest: <sha256>
runtime_proof_digest: <sha256>
boundary_check_helper: .agents/skills/proofloop-plan/references/active-spv-boundary-check.mjs
selected_work_item_refs: []
blocking_hard_parts: []
scope:
  stage: <stage-id>
  candidate_only: true
out_of_scope:
  - implementation
  - checkbox/status edits
  - Evidence edits
  - Receipt writes
  - Stage Plan admission
expected_result: PLAN_READY
```

## 必需输入

- canonical trust root；
- candidate `tasks.md`、Manifest 和 Evidence directory；
- 已完成并进入 stable Git boundary 的 candidate Plan、candidate input 和 Evidence
  skeleton；SPV dispatch 前 canonical worktree 必须 clean（Git 默认 ignore 的
  `.proofloop` Runtime artifacts 除外）；
- `plan_digest`、Manifest digest、Reference Index digest、Proof Index digest；
- boundary 的当前 Git HEAD `snapshot_digest`；
- 固定只读 helper
  `.agents/skills/proofloop-plan/references/active-spv-boundary-check.mjs`；dispatch 必须给出
  packet 全部 digest/snapshot 对应的完整闭合命令，SPV 不得自行拼接其他命令；
- selected AWI refs、Authority refs 和 blocking Hard Part status；
- candidate-only scope 和 out-of-scope；
- expected result。

## Digest 提取命令示例

SPV packet 的 digest 从已编译 Manifest 提取/重算，全部使用 kernel `computeDigest`：

```bash
node -e "
const fs = require('fs');
const { computeDigest } = require('<root>/packages/kernel/dist/index.js');
const m = JSON.parse(fs.readFileSync('<root>/.proofloop/manifests/<stage>.json', 'utf8'));
console.log('plan_digest            ', m.plan.plan_digest);
console.log('manifest_digest        ', computeDigest(m));
console.log('reference_index_digest', computeDigest(m.reference_index));
console.log('proof_index_digest     ', computeDigest(m.slices.map(s => s.proof_index)));
console.log('runtime_proof_digest   ', m.runtime_proof.proof_digest);
// 交叉验证：runtime_proof_digest 应等于 body 投影重算值
console.log('runtime_proof body     ', computeDigest({ spec_refs: m.runtime_proof.spec_refs, resolved_steps: m.runtime_proof.resolved_steps }));
"
```

`<root>` 是 canonical trust root；`snapshot_digest` 取当前 Git HEAD（`git rev-parse HEAD`）。
helper 会重算比对，误传 digest 会 fail closed，所以提取值必须来自上述同一 Manifest 文件。

## vNext 验证

SPV 必须在 stable Git boundary 后 fresh、只读，并按以下顺序验证：

1. 先且只运行 packet 中的闭合 helper command：
   `node .agents/skills/proofloop-plan/references/active-spv-boundary-check.mjs
   --project-root <root> --manifest <root-relative-manifest> --snapshot <HEAD>
   --plan-digest <digest> --manifest-digest <digest>
   --reference-index-digest <digest> --proof-index-digest <digest>
   --runtime-proof-digest <digest>`；只接受 `valid:true`，以此确认 canonical Git root、
   clean worktree、`snapshot_digest = HEAD` 和 canonical digest；helper fail/缺失或返回非闭合
   结果时必须返回 `RUNTIME_BLOCKER`，不得降级为 Read/Grep 或 Brain narrative；
2. 读取 Stage/Slice/Task Goal 和 Authority refs；
3. 验证 entity refs、kind、file/section digest 和 root-bound；**首轮必查实体内容非空**：
   每个被引用的 Acceptance/Seam/Oracle/Risk 实体在权威文件中必须有实质内容（非空正文），
   不得留到后续轮次深挖；
4. 验证 Proof Index 的 goal/task/acceptance/seam/oracle/risk 闭环；
5. 反向验证 Task → Slice → Stage closure；
6. 验证 Dependencies、Required Skills 和 Evidence path；
7. 验证每个 `implementation` Task 的 immutable `execution_scope` 存在，`code_paths`
   和 `test_paths` 非空、root-bound、无 forbidden overlap，并且 scope 参与
   `plan_digest`；`evidence-only` Task 不得被投影为 `implement-task`；
8. 验证 Runtime Proof 只引用结构化 `ProofSpecification`；
9. 验证 candidate Plan 没有被当作 admitted Plan；
10. 验证没有 CV Level、Proof Profile 或自然语言命令推断依赖。

语义内容位置：Acceptance/Seam/Oracle/Risk 的语义正文（实质内容）只存在于权威文件，
candidate 只承载 ref 引用（`<root-relative-path>#/entities/<id>`），不复制语义正文。
SPV 对 candidate 只验证引用可解析、kind 对齐且 root-bound，对权威文件验证实体内容
非空；不得要求 candidate 内嵌语义正文，也不得把实体内容非空推迟到后续轮次。

SPV 不读取或修改 Worker Evidence，不修改 Plan，不执行 Runtime Proof，不写 Receipt。

## 允许的结果

```text
PLAN_READY
PLAN_DEFECT
AUTHORITY_GAP
TECHNICAL_UNKNOWN
RUNTIME_BLOCKER
```

非成功结果必须包含：

```yaml
route_code: PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER
subtype: <specific-subtype>
finding_id: <id | none>
affected_stage: <stage-id>
affected_outcomes: []
affected_artifacts: []
affected_work_items: []
affected_hard_parts: []
evidence: <description>
reason: <description>
suggested_owner: Brain | proofloop-plan | User
invalidation_scope: []
resume_target:
  owner: Brain | proofloop-plan | User
  phase: STAGE_PLANNING | AUTHORITY_READINESS | RECOVERY_OR_EXCEPTION
  stage: <stage-id | none>
```

`PLAN_READY` 只允许 Brain 继续调用 Runtime Stage Plan admission；它本身不授予执行权。
Stage Plan admission 必须再次以 canonical root 检查 clean worktree 和
`snapshot_digest = HEAD`，不得手写 Receipt。progress/Agent narrative 不是 authority。
