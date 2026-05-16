---
name: openspec-archive-change
description: Archive a completed change using the official OpenSpec archive command. Use when the user wants to finalize and archive a change after implementation is complete.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.1"
  generatedBy: "1.3.1"
---

Archive a completed change using the official OpenSpec archive flow.

**Input**: Optionally specify a change name. If omitted, infer it from conversation context when possible. If multiple active changes exist and the target is ambiguous, list them and ask the user which one to archive.

**Important**: Prefer the official CLI command `openspec archive` as the canonical archive entry point. Do not manually merge specs or manually move change directories unless the CLI is unavailable or the user explicitly asks for manual recovery work.

**Steps**

1. **Select the change**

   If a change name is provided, use it.

   Otherwise:
   - Infer it from conversation context if possible
   - If only one active change exists, use it
   - If multiple active changes exist, run:
     ```bash
     openspec list --json
     ```
     Then present the active changes and ask the user which one to archive.

   Always announce: `Using change: <name>`.

2. **Check change status**

   Run:
   ```bash
   openspec status --change "<name>" --json
   ```

   Use this to understand:
   - `schemaName`
   - artifact completion status
   - whether the change looks ready for archive

3. **Warn on incomplete work, but do not replace the CLI**

   If `tasks.md` exists, read it and count incomplete `- [ ]` items.

   If artifacts are incomplete or tasks remain:
   - summarize the warnings clearly
   - ask the user whether to continue archiving anyway

   Do not try to manually sync specs or manually move files at this stage.

4. **Choose archive mode**

   Default command:
   ```bash
   openspec archive "<name>" --yes
   ```

   Use:
   ```bash
   openspec archive "<name>" --yes --skip-specs
   ```
   only when the change is clearly tooling-only, docs-only, or otherwise does not affect main specs.

   Use `--no-validate` only if the user explicitly asks to bypass validation or there is a documented recovery reason.

5. **Run the official archive command**

   Execute the chosen `openspec archive` command.

   The CLI is responsible for:
   - validating the change unless validation is explicitly skipped
   - merging delta specs into `openspec/specs/`
   - moving the change to `openspec/changes/archive/YYYY-MM-DD-<name>/`

6. **Report results**

   Summarize:
   - change name
   - schema name if known
   - command used
   - whether specs were synced or skipped
   - resulting archive path, if reported by the CLI
   - any warnings that existed before archive

**Output On Success**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Command:** openspec archive "<change-name>" --yes
**Result:** Archived successfully
```

If specs were skipped:

```
**Command:** openspec archive "<change-name>" --yes --skip-specs
**Specs:** Skipped by request / change type
```

**Guardrails**
- Prefer `openspec archive` over any manual archive procedure
- Do not manually compare and merge delta specs when the CLI is available
- Do not manually move change folders when the CLI is available
- Warn on incomplete tasks or artifacts, but let the user decide whether to proceed
- Use `--skip-specs` only for changes that truly do not modify source-of-truth specs
- Use `--no-validate` only with explicit user intent or a documented recovery scenario
- If the CLI archive fails, report the failure and stop; do not silently fall back to manual file operations
