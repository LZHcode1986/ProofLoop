# Authority Entity Marker Contract

为会被 Manifest 或 Plan 引用的 PRD/Tech Spec 实体提供稳定、可解析的引用边界。

## Use when

产出或修改 PRD、Tech Spec，且其中的实体可能被下游 Manifest/Plan 引用时，产出 Skill 必须加载本 Contract。

## Marker

每个将被引用的实体必须有一行显式 marker：

```text
<!-- proofloop:entity id="<id>" kind="<kind>" -->
```

- `id` 与 `kind` 顺序固定；
- `kind` 只能是 `goal | task | acceptance | seam | oracle | risk | proof_spec`；
- 同一权威文件内，实体 marker 的 `id` 必须唯一；
- marker 必须直接属于其声明实体，不用 heading、表格行或全文搜索替代。

## Reference boundary

- 下游只引用 `<root-relative-path>#/entities/<entity-id>`；
- 产出方不得在 candidate Plan 中复制或伪造外部 Authority marker；
- 缺失、重复、非法或 kind/id 不一致的 marker 必须在 Manifest/Plan 消费前 fail closed；
- marker 是上游产出义务，不是 Materializer 或 Runtime 补写 Authority 的修复机制。

## Completion criterion

产出 Skill 只有在每个声明会被下游引用的实体都具备唯一、合法且可解析的 marker，并且引用使用 canonical entity ref 后，才可报告该 Authority artifact ready。

PRD 与 Tech Spec 的具体正文、确认节奏和 artifact ownership 仍由各自产出 Skill 负责；本 Contract 只定义 marker 语义。
