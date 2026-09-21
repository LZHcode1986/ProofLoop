/**
 * @proofloop/runtime — vNext Project Stage Map artifact parser & entry
 * resolver (S02-A-T01).
 *
 * Parses the canonical project-level Rolling-Wave Map artifact
 * (`delivery/project-stage-map.md`, tech-spec/contracts.md §4.0) — a closed
 * Markdown table whose columns are Stage / depends_on / 目标（独立交付
 * outcome）/ entry criteria / Authority refs — into typed `StageMapEntry`
 * values, and resolves a Thin Plan's `project_stage_map_ref`
 * (`delivery/project-stage-map.md#<stage-id>`, contracts §4.1) to the
 * referenced entry.
 *
 * This is a PURE function seam (STATIC-21 / contracts §4.1):
 *   - it reads no MES facts, writes no store, touches no Git state and never
 *     reads any Authority text other than the Map markdown passed in;
 *   - a Thin Plan binds the Map entry through the ref + the same candidate
 *     Git basis; the entry is rebuilt here from the Map text itself;
 *   - the Map does NOT carry operational readiness (STATIC-22): a table with
 *     a readiness column (ready / blocked / executing / accepted) is
 *     rejected, and readiness is never part of a typed entry.
 *
 * Every failure is a typed `StageMapResolutionError` carrying tech-spec
 * contracts §7 `PLAN_GAP` semantics: missing/empty artifact, invalid map
 * ref, malformed table shape, duplicate stage ids, an operational-readiness
 * column, or an unknown entry id — never guessed or papered over.
 */
import { isCanonicalStageId } from './stage-id';
import { isCanonicalAuthorityRef } from '../mes/binding';

/** Single canonical active project-map path (STATIC-21 / contracts §4.0). */
export const CANONICAL_PROJECT_STAGE_MAP_PATH = 'delivery/project-stage-map.md' as const;

/** The closed set of typed fields a Map entry carries (PO-S02-A-01). */
export type StageMapEntryField =
  | 'stage_id'
  | 'depends_on'
  | 'goal'
  | 'entry_criteria'
  | 'authority_refs';

/** The closed field set of a typed Map entry (PO-S02-A-01). */
export const STAGE_MAP_ENTRY_FIELDS: readonly StageMapEntryField[] = [
  'stage_id',
  'depends_on',
  'goal',
  'entry_criteria',
  'authority_refs',
];

/**
 * A single Map entry rebuilt from one Markdown table row. Field values are
 * the raw (trimmed) cell texts: `depends_on` / `goal` / `entry_criteria` /
 * `authority_refs` are predicate definitions or compressed ref cells, so the
 * seam keeps them opaque instead of inventing a grammar the Authority does
 * not define (contracts §4.0). Operational readiness is never a field.
 */
export interface StageMapEntry {
  /** Canonical Stage ID (`^S\d+$`); unique within one Map. */
  readonly stage_id: string;
  /** Raw `depends_on` cell. */
  readonly depends_on: string;
  /** Raw goal cell（独立交付 outcome）. */
  readonly goal: string;
  /** Raw `entry criteria` cell（准入谓词定义）. */
  readonly entry_criteria: string;
  /** Raw `Authority refs` cell. */
  readonly authority_refs: string;
}

/**
 * Typed failure codes for the Map seam. Every code maps to the §7
 * `PLAN_GAP` outcome in the Contracts Authority ("SPV / Brain 无法从
 * candidate Plan + `project_stage_map_ref` + candidate Git basis 重建被验证
 * 的 current Stage Map entry").
 */
export type StageMapResolutionErrorCode =
  /** The Map artifact is missing / empty / contains no table. */
  | 'MAP_MISSING'
  /** The map ref is not `<delivery/project-stage-map.md>#<stage-id>`. */
  | 'MAP_REF_INVALID'
  /** Table / header / row / cell shape is not the closed §4.0 shape. */
  | 'MAP_MALFORMED'
  /** Map carries an operational-readiness column (STATIC-22 violation). */
  | 'MAP_READINESS_CACHE'
  /** The same Stage ID appears more than once in the Map. */
  | 'MAP_DUPLICATE_ENTRY'
  /** The ref names a canonical stage id with no entry in the Map. */
  | 'MAP_UNKNOWN_ENTRY';

/**
 * Fail-closed error of the Map seam. `code` discriminates the failure and
 * `stageRef` carries the offending `project_stage_map_ref` when one was
 * being resolved.
 */
export class StageMapResolutionError extends Error {
  public readonly code: StageMapResolutionErrorCode;
  public readonly stageRef?: string;

  constructor(code: StageMapResolutionErrorCode, stageRef?: string, detail?: string) {
    const location = typeof stageRef === 'string' && stageRef.length > 0 ? ` (ref: ${stageRef})` : '';
    const message =
      `Project Stage Map resolution failed: ${code}${location}${detail ? ` — ${detail}` : ''}` +
      '（契约 §7 PLAN_GAP 语义：no-write，Planner 修正 ref 或 Map 后重建）';
    super(message);
    this.name = 'StageMapResolutionError';
    this.code = code;
    this.stageRef = stageRef;
  }
}

/** Canonical map table headers in the exact §4.0 order (closed set). */
const CANONICAL_HEADERS: readonly string[] = [
  'Stage',
  'depends_on',
  '目标（独立交付 outcome）',
  'entry criteria',
  'Authority refs',
];

/** Tokens marking an operational-readiness column (STATIC-22 vocab). */
const READINESS_TOKEN_RE = /readiness|ready|blocked|executing|accepted/i;

/** Split one Markdown table line into trimmed cells. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return []; // not a table row
  const cells = trimmed.split('|');
  cells.shift();
  cells.pop();
  return cells.map((cell) => cell.trim());
}

/** A separator row (`|---|---|---|`, optional leading/trailing `:`). */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function expectHeaders(cells: readonly string[]): void {
  if (cells.length !== CANONICAL_HEADERS.length) {
    // A non-closed column count only passes when the extra column is an
    // operational-readiness cache — which is itself a STATIC-22 violation.
    if (cells.some((cell) => READINESS_TOKEN_RE.test(cell) && !(CANONICAL_HEADERS as readonly string[]).includes(cell))) {
      throw new StageMapResolutionError(
        'MAP_READINESS_CACHE',
        undefined,
        'Map table must not cache operational readiness (STATIC-22)',
      );
    }
    throw new StageMapResolutionError(
      'MAP_MALFORMED',
      undefined,
      `expected exactly ${CANONICAL_HEADERS.length} closed headers, got ${cells.length}`,
    );
  }
  for (let i = 0; i < CANONICAL_HEADERS.length; i++) {
    if (cells[i] !== CANONICAL_HEADERS[i]) {
      throw new StageMapResolutionError(
        'MAP_MALFORMED',
        undefined,
        `header[${i}] is ${JSON.stringify(cells[i])}, expected ${JSON.stringify(CANONICAL_HEADERS[i])}`,
      );
    }
  }
}

function expectDataRow(cells: readonly string[], lineIndex: number): void {
  if (cells.length !== CANONICAL_HEADERS.length) {
    throw new StageMapResolutionError(
      'MAP_MALFORMED',
      undefined,
      `row ${lineIndex} has ${cells.length} cells, expected ${CANONICAL_HEADERS.length}`,
    );
  }
}

/**
 * Parse a canonical Project Stage Map artifact (Markdown text) into typed
 * entries. Pure: the caller supplies the Map text; the seam reads no MES /
 * Git / other authorities.
 *
 * @throws {StageMapResolutionError} with a closed code (PLAN_GAP semantics)
 *   for missing/empty artifacts, malformed tables, non-canonical stage ids,
 *   duplicate stage ids and readiness columns.
 */
export function parseStageMap(mapMarkdown: string): readonly StageMapEntry[] {
  if (typeof mapMarkdown !== 'string' || mapMarkdown.trim().length === 0) {
    throw new StageMapResolutionError('MAP_MISSING', undefined, 'Map artifact is missing or empty');
  }

  const rows = mapMarkdown
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'));
  if (rows.length === 0) {
    throw new StageMapResolutionError('MAP_MISSING', undefined, 'Map artifact contains no Markdown table');
  }

  expectHeaders(splitRow(rows[0]));
  if (rows.length < 2 || !isSeparatorRow(splitRow(rows[1]))) {
    throw new StageMapResolutionError('MAP_MALFORMED', undefined, 'Map table is missing its separator row');
  }

  const seen = new Map<string, StageMapEntry>();
  for (let i = 2; i < rows.length; i++) {
    const line = rows[i];
    const cells = splitRow(line);
    expectDataRow(cells, i + 1);

    const stageCell = cells[0];
    if (!isCanonicalStageId(stageCell)) {
      throw new StageMapResolutionError(
        'MAP_MALFORMED',
        undefined,
        `stage cell ${JSON.stringify(stageCell)} is not a canonical Stage ID (expected /^S\\d+$/)`,
      );
    }
    for (const [j, cell] of cells.entries()) {
      if (cell.length === 0) {
        throw new StageMapResolutionError(
          'MAP_MALFORMED',
          undefined,
          `row ${i + 1} cell ${j} is empty`,
        );
      }
    }

    if (seen.has(stageCell)) {
      throw new StageMapResolutionError(
        'MAP_DUPLICATE_ENTRY',
        `${CANONICAL_PROJECT_STAGE_MAP_PATH}#${stageCell}`,
        `stage id ${stageCell} appears more than once`,
      );
    }
    seen.set(stageCell, {
      stage_id: stageCell,
      depends_on: cells[1],
      goal: cells[2],
      entry_criteria: cells[3],
      authority_refs: cells[4],
    });
  }

  if (seen.size === 0) {
    throw new StageMapResolutionError('MAP_MALFORMED', undefined, 'Map table has no entries');
  }
  return [...seen.values()];
}

/**
 * Rebuild the current Map entry from `project_stage_map_ref`
 * (`delivery/project-stage-map.md#<stage-id>`) on the same Map basis.
 * Pure: the runtime caller supplies the Map text read at that basis.
 *
 * @throws {StageMapResolutionError} for invalid map refs, missing/empty
 *   artifacts, malformed tables, duplicate stage ids and unknown entries
 *   (contracts §7 `PLAN_GAP` semantics — no second operational state source).
 */
export function resolveStageMapEntry(mapMarkdown: string, ref: string): StageMapEntry {
  if (typeof ref !== 'string' || !isCanonicalAuthorityRef(ref)) {
    throw new StageMapResolutionError('MAP_REF_INVALID', ref, 'expected canonical ref "<path>#<section>"');
  }
  const hash = ref.indexOf('#');
  const pathPart = ref.slice(0, hash);
  const stagePart = ref.slice(hash + 1);
  if (pathPart !== CANONICAL_PROJECT_STAGE_MAP_PATH) {
    throw new StageMapResolutionError(
      'MAP_REF_INVALID',
      ref,
      `project_stage_map_ref must point at ${CANONICAL_PROJECT_STAGE_MAP_PATH} (STATIC-21)`,
    );
  }
  if (!isCanonicalStageId(stagePart)) {
    throw new StageMapResolutionError(
      'MAP_REF_INVALID',
      ref,
      'map ref must name a canonical Stage ID (e.g. ...#S02)',
    );
  }

  const entries = parseStageMap(mapMarkdown);
  const entry = entries.find((candidate) => candidate.stage_id === stagePart);
  if (entry === undefined) {
    throw new StageMapResolutionError(
      'MAP_UNKNOWN_ENTRY',
      ref,
      `Map has no entry for stage ${stagePart}`,
    );
  }
  return entry;
}