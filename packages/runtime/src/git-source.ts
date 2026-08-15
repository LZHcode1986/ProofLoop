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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalPathWithinRoot } from './path-guard';

// ============================================================
// Result types
// ============================================================

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
export class GitSourceError extends Error {
  public readonly code: 'RUNTIME.SCHEMA_MISMATCH' = 'RUNTIME.SCHEMA_MISMATCH';
  public readonly source: 'git' = 'git';
  public readonly reason: string;

  constructor(message: string) {
    super(message);
    this.name = 'GitSourceError';
    this.reason = message;
  }
}

// ============================================================
// Git subprocess helpers (deterministic, read-only)
// ============================================================

/** True when the subprocess failed because the `git` executable is missing. */
function isExecutableMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Assert that `projectRoot` IS the git root (not merely inside a work tree).
 *
 * Uses `git rev-parse --show-toplevel` and compares the resolved real paths
 * (symlink/alias safe, e.g. macOS `/tmp` → `/private/tmp`). Any git failure
 * or a toplevel that differs from `projectRoot` → `GitSourceError`
 * (`RUNTIME.SCHEMA_MISMATCH` — Git source unavailable, PO-S02-C-02).
 */
export function resolveGitRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  let toplevel: string;
  try {
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolved,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (isExecutableMissing(err)) {
      throw new GitSourceError(
        `git executable is unavailable; cannot resolve a git work tree for ${resolved}`,
      );
    }
    throw new GitSourceError(`projectRoot is not inside a git work tree: ${resolved}`);
  }
  if (toplevel.length === 0) {
    throw new GitSourceError(`projectRoot is not inside a git work tree: ${resolved}`);
  }
  let realTop: string;
  let realRoot: string;
  try {
    realTop = fs.realpathSync(toplevel);
    realRoot = fs.realpathSync(resolved);
  } catch {
    throw new GitSourceError(`projectRoot cannot be resolved: ${resolved}`);
  }
  if (realTop !== realRoot) {
    throw new GitSourceError(`projectRoot is not the git root (git root is ${toplevel})`);
  }
  return toplevel;
}

/**
 * Read the git HEAD sha (`git rev-parse HEAD`). An unborn repository (git
 * init without any commit) fails closed with `GitSourceError` — never
 * guessed.
 */
export function readGitHead(gitRoot: string): string {
  let head: string;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (isExecutableMissing(err)) {
      throw new GitSourceError('git executable is unavailable; cannot read HEAD');
    }
    throw new GitSourceError(
      'cannot resolve HEAD (unborn repository?) — Git source unavailable',
    );
  }
  if (head.length === 0) {
    throw new GitSourceError('cannot resolve HEAD (unborn repository?) — Git source unavailable');
  }
  return head;
}

// ============================================================
// tasks.md parsing
// ============================================================

/** Canonical tasks.md path for a stage: `<projectRoot>/delivery/stages/<stage>/tasks.md`. */
export function defaultTasksMdPath(projectRoot: string, stageId: string): string {
  return path.join(projectRoot, 'delivery', 'stages', stageId, 'tasks.md');
}

/**
 * Extract the slice's region from a tasks.md document when the canonical
 * markers are present. Falls back to the whole document when either marker
 * is absent — task IDs are globally unique (`<sliceId>-T<n>`), so the
 * whole-document parse is unambiguous and deterministic (never a guess).
 */
export function extractSliceRegion(content: string, sliceId: string): string {
  const beginMarker = `<!-- SLICE:${sliceId}:BEGIN -->`;
  const endMarker = `<!-- SLICE:${sliceId}:END -->`;
  const begin = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return content;
  }
  return content.slice(begin, end + endMarker.length);
}

/**
 * Parse per-task checkbox states (`- [x]` / `- [ ]`) from tasks.md content.
 *
 * When `sliceId` is provided and its region markers are present, only the
 * slice region is parsed (a decoy checkbox for the same task ID living in
 * another slice's region is ignored). Results follow the `taskIds` order.
 */
export function parseTaskCheckboxes(
  content: string,
  taskIds: readonly string[],
  sliceId?: string,
): GitTaskCheckboxState[] {
  const region =
    sliceId !== undefined && sliceId.length > 0
      ? extractSliceRegion(content, sliceId)
      : content;
  const checkedMap = new Map<string, boolean>();
  const checkboxRegex = /^- \[( |x|X)\] (\S+):/gm;
  let match: RegExpExecArray | null;
  while ((match = checkboxRegex.exec(region)) !== null) {
    const isChecked = match[1] === 'x' || match[1] === 'X';
    checkedMap.set(match[2], isChecked);
  }
  return taskIds.map((taskId) => ({
    task_id: taskId,
    checked: checkedMap.get(taskId) ?? false,
  }));
}

// ============================================================
// Evidence-file parsing
// ============================================================

/** Body of a `##`-level section (empty when the heading is absent). */
function sectionBetween(content: string, heading: string): string {
  const lines = content.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Whether the per-task Evidence section has a non-placeholder entry for the
 * task: a `### <taskId>` (or `### <taskId>: …`) subsection exists under
 * `## Task Evidence` and the section is not the initial placeholder
 * (`*No tasks have been executed yet.*`).
 */
export function hasTaskEvidenceWritten(content: string, taskId: string): boolean {
  const section = sectionBetween(content, '## Task Evidence');
  if (section.length === 0) return false;
  const nonEmpty = section
    .split('\n')
    .filter(
      (line) =>
        line.trim().length > 0 &&
        !/^\*No tasks have been executed yet\.\*$/.test(line.trim()),
    );
  if (nonEmpty.length === 0) return false;
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^###\\s+${escaped}\\b`, 'm').test(section);
}

/**
 * Whether `## Current Slice Evidence` is finalized: the
 * `### Proof Obligation Coverage` matrix contains at least one filled
 * (non-placeholder) data row. A skeleton `| *None* | | | | |` row, an
 * empty table, or a missing section all mean NOT finalized.
 */
export function isSliceEvidenceFinalized(content: string): boolean {
  const lines = content.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '### Proof Obligation Coverage') {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return false;
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i].trim())) {
      endIdx = i;
      break;
    }
  }
  const tableLines = lines
    .slice(headingIdx + 1, endIdx)
    .filter((line) => line.trim().startsWith('|'));
  const dataRows = tableLines.filter((line, index) => {
    if (index === 0) return false; // header row
    if (index === 1 && /^[\s|:\-]+$/.test(line.trim())) return false; // separator row
    return true;
  });
  return dataRows.some((row) => {
    const trimmed = row.trim();
    if (/^\|\s*\*None\*\s*\|/.test(trimmed)) return false;
    const cells = trimmed.split('|').filter((c) => c.trim().length > 0);
    return cells.length >= 2;
  });
}

/** Parse evidence-file facts (per-task + finalized) from raw content. */
export function parseEvidenceFacts(
  content: string,
  taskIds: readonly string[],
): EvidenceParsedFacts {
  return {
    evidence: taskIds.map((taskId) => ({
      task_id: taskId,
      evidence_written: hasTaskEvidenceWritten(content, taskId),
    })),
    evidence_finalized: isSliceEvidenceFinalized(content),
  };
}

// ============================================================
// Git source reader
// ============================================================

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
export function gitSource(input: GitSourceInput): GitSourceResult {
  const { projectRoot, stageId, sliceId, taskIds } = input;

  // 1. Git root assertion (PO-S02-C-02: non-git root → Git source unavailable).
  const gitRoot = resolveGitRoot(projectRoot);

  // 2. HEAD (deterministic git subprocess).
  const head = readGitHead(gitRoot);

  // 3. tasks.md work-tree facts — missing file fails closed (never guess).
  const tasksMdPath = input.tasksMdPath ?? defaultTasksMdPath(projectRoot, stageId);
  // Trust-root boundary (S2-F-003): a tasks.md path whose canonical path
  // escapes the project root is NEVER read (fail-closed, same structured
  // GitSourceError as an unavailable Git source).
  if (canonicalPathWithinRoot(projectRoot, tasksMdPath) === null) {
    throw new GitSourceError(
      `tasks.md path escapes the project root trust boundary: ${tasksMdPath}`,
    );
  }
  let tasksMdContent: string;
  try {
    tasksMdContent = fs.readFileSync(tasksMdPath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GitSourceError(`cannot read tasks.md at ${tasksMdPath}: ${reason}`);
  }
  const tasks = parseTaskCheckboxes(tasksMdContent, taskIds, sliceId);

  // 4. Evidence-file work-tree facts — a missing file is NOT fatal; every
  //    evidence fact stays false and the reconcile layer derives the
  //    recoverable warn Finding (PO-S02-C-02). An ESCAPE is fatal: an
  //    evidence file whose canonical path escapes the project root must never
  //    be read (S2-F-003) — unlike a missing file (reported as
  //    evidence_file_present:false), an escape is a trust violation and no
  //    outside file may masquerade as slice evidence.
  const evidenceFilePath = path.join(projectRoot, input.evidencePath);
  if (canonicalPathWithinRoot(projectRoot, evidenceFilePath) === null) {
    throw new GitSourceError(
      `evidence file path escapes the project root trust boundary: ${evidenceFilePath}`,
    );
  }
  let evidenceContent: string | null = null;
  try {
    evidenceContent = fs.readFileSync(evidenceFilePath, 'utf-8');
  } catch {
    evidenceContent = null;
  }
  const evidenceFilePresent = evidenceContent !== null;
  const parsed =
    evidenceFilePresent && evidenceContent !== null
      ? parseEvidenceFacts(evidenceContent, taskIds)
      : {
          evidence: taskIds.map((taskId) => ({
            task_id: taskId,
            evidence_written: false,
          })),
          evidence_finalized: false,
        };

  return {
    head,
    gitRoot,
    tasks_md_path: tasksMdPath,
    tasks,
    evidence_path: evidenceFilePath,
    evidence_file_present: evidenceFilePresent,
    evidence: parsed.evidence,
    evidence_finalized: parsed.evidence_finalized,
  };
}
