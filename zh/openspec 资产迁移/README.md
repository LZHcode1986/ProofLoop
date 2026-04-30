# OpenSpec 资产迁移包

这是一套可直接迁移到其他项目的 OpenSpec 起始资产。

使用方式：
1. 开始配置前，默认按 `test-driven-development` 处理，不再询问是否需要。
2. 再替换 `config.yaml.example` 里的项目占位符。
3. 再按需复制 `schemas/project-schema/` 下的模板。
4. 然后把质量门禁与用户说明接入项目级工作流。
5. 归档流程直接遵循官方 `openspec archive` 行为，不再额外迁移独立归档文档。
6. 必须用 `../../skills/openspec-propose/SKILL.md` 覆盖目标项目原有的 `propose` skill。
7. 用 `../../skills/openspec-apply-change/SKILL.md` 覆盖目标项目原有的 `apply` skill。
8. 然后检查目标项目是否已有 `test-driven-development` skill；如果没有，则帮助用户把 `../../skills/test-driven-development/SKILL.md` 配置到 OpenSpec skills 同目录。

迁移顺序建议：
1. `config.yaml.example`
2. `schemas/project-schema/`
3. `QUALITY-GATE.md`
4. `用户说明.md`
5. `../../skills/openspec-propose/SKILL.md`
6. `../../skills/openspec-apply-change/SKILL.md`
7. 然后检查目标项目是否已有 `test-driven-development` skill，缺失则接入 `../../skills/test-driven-development/SKILL.md`

说明：
1. 这里不包含任何本项目业务实现内容。
2. 所有可变内容都用占位符标记，复制到新项目后再替换。
3. `schemas/project-schema/` 只是目录名示例，新项目可以保留，也可以改成自己的 schema 名称。
4. `skills/openspec-propose/SKILL.md` 是主迁移入口。
5. `skills/openspec-apply-change/SKILL.md` 作为默认实施 skill 配置。
6. `skills/test-driven-development/SKILL.md` 由 Agent 先检查是否缺失，缺失则补齐。
7. `propose-改造思路.md` 和 `apply-改造思路.md` 现在只作为设计说明保留。
8. `用户说明.md` 只面向用户，不承担规范或流程职责。
9. 归档直接依赖官方 `openspec archive`，不再要求单独迁移归档文档。
