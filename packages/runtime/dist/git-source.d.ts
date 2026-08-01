/**
 * @proofloop/runtime — Git source reader (S02-C-T02)
 *
 * Reads the Git work-tree facts of one slice of a stage reconcile:
 *   - asserts `projectRoot` IS the git root (`git rev-parse --show-toplevel`
 *     with resolved-path equality) — a non-git root / git-subdir-as-root
 *     makes the Git source unavailable (structured `GitSourceError`,
 *     canonical code `RUNTIME.SCHEMA_MISMATCH`, PO-S02-C-02);
 *   - reads HEAD via `git rev-parse HEAD` (deterministic git subprocess);
 *   - reads the canonical `tasks.md` work-tree file and parses per-task
 *     checkbox states (`- [x]` / `- [ ]`) in the manifest-declared task-ID
 *     order, restricted to the slice region markers
 *     (`<!-- SLICE:<id>:BEGIN -->` … `<!-- SLICE:<id>:END -->`) when
 *     present (whole-document fallback when the markers are absent — task
 *     IDs are globally unique, so the fallback is unambiguous);
 *   - reads the slice Evidence file work-tree facts: per-task
 *     `evidence_written` (non-placeholder `### <taskId>` subsection under
 *     `## Task Evidence`) and `evidence_finalized` (the `## Current Slice
 *     Evidence` PO-coverage matrix is filled / non-placeholder).
 *
 * Determinism (HP-003): the git subprocess output is the canonical 40-hex
 * HEAD sha; all parsing is locale-independent plain string/line matching —
 * the same input always yields the same output. Read-only; never writes or
 * repairs.
 *
 * Failure semantics (fail-closed, never guess): non-git root, unborn HEAD,
 * and a missing/unreadable tasks.md throw `GitSourceError`. A missing
 * Evidence file is NOT fatal — the source reports
 * `evidence_file_present: false` with every evidence fact false, so the
 * reconcile layer can emit the recoverable warn Finding of PO-S02-C-02
 * (task checked while evidence missing, or vice versa).
 */
/** One task's checkbox state parsed from tasks.md. */
export interface GitTaskCheckboxState {
    readonly task_id: string;
    /** Whether the tasks.md checkbox is checked ([x] vs [ ]). */
    readonly checked: boolean;
}
/** One task's evidence_written fact from the slice evidence file. */
export interface GitEvidenceTaskFacts {
    readonly task_id: string;
    /** Whether the per-task Evidence section has a non-placeholder entry. */
    readonly evidence_written: boolean;
}
/** Parsed evidence-file facts (per-task + finalized). */
export interface EvidenceParsedFacts {
    readonly evidence: readonly GitEvidenceTaskFacts[];
    /** Whether `## Current Slice Evidence`'s PO matrix is filled / non-placeholder. */
    readonly evidence_finalized: boolean;
}
export interface GitSourceInput {
    readonly projectRoot: string;
    readonly stageId: string;
    readonly sliceId: string;
    /** Task IDs in manifest declaration order. */
    readonly taskIds: readonly string[];
    /**
     * Path to tasks.md. Defaults to
     * `<projectRoot>/delivery/stages/<stageId>/tasks.md`.
     */
    readonly tasksMdPath?: string;
    /** Slice evidence path (manifest `evidence_path`), relative to projectRoot. */
    readonly evidencePath: string;
}
export interface GitSourceResult {
    /** git HEAD sha (40 hex chars). */
    readonly head: string;
    /** Absolute path of the git work-tree root. */
    readonly gitRoot: string;
    /** Absolute path of the tasks.md file read. */
    readonly tasks_md_path: string;
    /** Per-task checkbox states in manifest declaration order. */
    readonly tasks: readonly GitTaskCheckboxState[];
    /** Absolute path of the evidence file resolved. */
    readonly evidence_path: string;
    /** Whether the evidence file exists in the work tree. */
    readonly evidence_file_present: boolean;
    /** Per-task evidence_written facts in manifest declaration order. */
    readonly evidence: readonly GitEvidenceTaskFacts[];
    /** Whether the slice evidence PO matrix is finalized. */
    readonly evidence_finalized: boolean;
}
/**
 * Structured Git-source-unavailable condition (PO-S02-C-02): the canonical
 * code for a non-git root / unavailable Git source is RUNTIME.SCHEMA_MISMATCH.
 */
export declare class GitSourceError extends Error {
    readonly code: 'RUNTIME.SCHEMA_MISMATCH';
    readonly source: 'git';
    readonly reason: string;
    constructor(message: string);
}
/**
 * Assert that `projectRoot` IS the git root (not merely inside a work tree).
 *
 * Uses `git rev-parse --show-toplevel` and compares the resolved real paths
 * (symlink/alias safe, e.g. macOS `/tmp` → `/private/tmp`). Any git failure
 * or a toplevel that differs from `projectRoot` → `GitSourceError`
 * (`RUNTIME.SCHEMA_MISMATCH` — Git source unavailable, PO-S02-C-02).
 */
export declare function resolveGitRoot(projectRoot: string): string;
/**
 * Read the git HEAD sha (`git rev-parse HEAD`). An unborn repository (git
 * init without any commit) fails closed with `GitSourceError` — never
 * guessed.
 */
export declare function readGitHead(gitRoot: string): string;
/** Canonical tasks.md path for a stage: `<projectRoot>/delivery/stages/<stage>/tasks.md`. */
export declare function defaultTasksMdPath(projectRoot: string, stageId: string): string;
/**
 * Extract the slice's region from a tasks.md document when the canonical
 * markers are present. Falls back to the whole document when either marker
 * is absent — task IDs are globally unique (`<sliceId>-T<n>`), so the
 * whole-document parse is unambiguous and deterministic (never a guess).
 */
export declare function extractSliceRegion(content: string, sliceId: string): string;
/**
 * Parse per-task checkbox states (`- [x]` / `- [ ]`) from tasks.md content.
 *
 * When `sliceId` is provided and its region markers are present, only the
 * slice region is parsed (a decoy checkbox for the same task ID living in
 * another slice's region is ignored). Results follow the `taskIds` order.
 */
export declare function parseTaskCheckboxes(content: string, taskIds: readonly string[], sliceId?: string): GitTaskCheckboxState[];
/**
 * Whether the per-task Evidence section has a non-placeholder entry for the
 * task: a `### <taskId>` (or `### <taskId>: …`) subsection exists under
 * `## Task Evidence` and the section is not the initial placeholder
 * (`*No tasks have been executed yet.*`).
 */
export declare function hasTaskEvidenceWritten(content: string, taskId: string): boolean;
/**
 * Whether `## Current Slice Evidence` is finalized: the
 * `### Proof Obligation Coverage` matrix contains at least one filled
 * (non-placeholder) data row. A skeleton `| *None* | | | | |` row, an
 * empty table, or a missing section all mean NOT finalized.
 */
export declare function isSliceEvidenceFinalized(content: string): boolean;
/** Parse evidence-file facts (per-task + finalized) from raw content. */
export declare function parseEvidenceFacts(content: string, taskIds: readonly string[]): EvidenceParsedFacts;
/**
 * Read the Git work-tree facts of one slice (PO-S02-C-01 data-source part).
 *
 * Deterministic (HP-003) and read-only. Fail-closed on non-git root, unborn
 * HEAD and missing tasks.md (`GitSourceError`, `RUNTIME.SCHEMA_MISMATCH`);
 * a missing evidence file is surfaced as `evidence_file_present: false`
 * with every evidence fact false (recoverable warn condition).
 *
 * @throws {GitSourceError} when the Git source is unavailable.
 */
export declare function gitSource(input: GitSourceInput): GitSourceResult;
//# sourceMappingURL=git-source.d.ts.map