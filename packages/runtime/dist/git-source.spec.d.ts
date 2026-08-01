/**
 * gitSource — S02-C-T02 (PO-S02-C-01 data-source part / PO-S02-C-02 source-error part)
 *
 * Verifies the runtime Git source seam against REAL filesystem fixtures:
 * a temporary directory initialized as a REAL git repository (git init +
 * git config + real commits), with real `tasks.md` / evidence files in the
 * canonical layout. No mocks, no cached state files (HP-003).
 *
 * Behaviors under test:
 *   - HEAD is read from `git rev-parse HEAD` (deterministic subprocess).
 *   - per-task checkbox states (`- [x]` / `- [ ]`) are parsed in the
 *     manifest-declared task-ID order, restricted to the slice region
 *     markers (`<!-- SLICE:<id>:BEGIN -->` … `<!-- SLICE:<id>:END -->`)
 *     when present.
 *   - per-task evidence_written (non-placeholder `### <taskId>` subsection
 *     under `## Task Evidence`) and evidence_finalized (the PO-coverage
 *     matrix under `## Current Slice Evidence` is filled / non-placeholder).
 *   - non-git root / git-subdir-as-root → GitSourceError
 *     (RUNTIME.SCHEMA_MISMATCH — Git source unavailable, PO-S02-C-02).
 *   - unborn HEAD (git init without commit) → GitSourceError (fail-closed).
 *   - missing tasks.md → GitSourceError (fail-closed, never guess).
 *   - missing evidence file → evidence_file_present: false with every
 *     evidence fact false (recoverable — reconcile turns the mismatch into
 *     the warn Finding of PO-S02-C-02).
 *   - determinism (HP-003): two reads of the same fixture are deep-equal.
 */
export {};
//# sourceMappingURL=git-source.spec.d.ts.map