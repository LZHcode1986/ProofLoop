/**
 * Project Stage Map artifact parser + entry resolver tests (S02-A-T01).
 *
 * # PO: PO-S02-A-01, PO-S02-A-02
 *
 * Exercises the pure vNext stage-map seam on
 * packages/runtime/src/vnext/stage-map.ts (exported through
 * packages/runtime/src/vnext/index.ts):
 *   - a canonical Map artifact (contracts §4.0 table: Stage / depends_on /
 *     目标（独立交付 outcome） / entry criteria / Authority refs) parses into
 *     typed StageMapEntry values with the CLOSED five-field set
 *     (stage_id / depends_on / goal / entry_criteria / authority_refs) and
 *     never exposes an operational-readiness field (PO-S02-A-01 /
 *     STATIC-22);
 *   - `project_stage_map_ref` (`delivery/project-stage-map.md#<stage-id>`)
 *     resolves the current entry on the same Map basis; missing/empty
 *     artifact, invalid map ref, unknown entry, duplicate stage ids,
 *     malformed table shape and an operational-readiness column all fail
 *     closed with a typed StageMapResolutionError carrying contracts §7
 *     `PLAN_GAP` semantics (PO-S02-A-02).
 *
 * Imports the compiled runtime dist (built by `npm run build`) like the rest
 * of the runtime tests. Fixtures are plain markdown strings — the seam is
 * pure and touches no filesystem, Git state or MES facts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_PROJECT_STAGE_MAP_PATH,
  parseStageMap,
  resolveStageMapEntry,
  StageMapResolutionError,
} from '../dist/vnext/stage-map';
import {
  parseStageMap as parseStageMapFromSeam,
  resolveStageMapEntry as resolveStageMapEntryFromSeam,
} from '../dist/vnext';
import type { StageMapEntry, StageMapResolutionErrorCode } from '../dist/vnext/stage-map';

const MAP_HEADER = '| Stage | depends_on | 目标（独立交付 outcome） | entry criteria | Authority refs |';
const MAP_SEPARATOR = '|---|---|---|---|---|';
const S02_REF = `${CANONICAL_PROJECT_STAGE_MAP_PATH}#S02`;

/** A canonical Map fixture mirroring the real artifact's machine shape. */
const CANONICAL_MAP = `# Project Stage Map — ProofLoop v2（公共 Rolling-Wave Planning artifact）

> 本文件是 project-level Rolling-Wave Planning 的唯一 active map（tech-spec/contracts.md §4.0）。
> Map 只保存计划事实（Stage id / depends_on / goal / entry criteria / Authority refs），
> 不缓存 operational readiness（STATIC-22）。

${MAP_HEADER}
${MAP_SEPARATOR}
| S01 | \`PROPOSE_READY\` + clean Git baseline | MES durable facts 基础：闭集 fact envelope、root-bound snapshot store | \`PROPOSE_READY\` 已确认；四类 canonical Authority 完整 | PRD#FR-003/004/005/009/011；architecture#HP-001/004/006/007/010、ADR-009/010/011 |
| S02 | S01 \`STAGE_ACCEPTED\`（MES seed 完成） | NORMAL Rolling-Wave Planning 支撑：首份 active 公共 Map artifact + \`project_stage_map_ref\` Map-entry 重建 seam | S01 已 \`STAGE_ACCEPTED\`（\`mes:fact:stage:S01:accepted\` durable）；build + 现有测试基线 green | PRD#FR-003/004/005/009/011/013/014；architecture#FR-003/004/005、HP-001/004/006/007/010、ADR-013；contracts#2.2.2、4.0/4.1/4.2、5.1、6.0、7 |
`;

describe('Project Stage Map vnext seam (S02-A-T01)', () => {
  test('parses the canonical stage map artifact into typed entries', () => {
    const entries = parseStageMap(CANONICAL_MAP);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e) => e.stage_id),
      ['S01', 'S02'],
    );

    const s01 = entries[0];
    assert.equal(s01.stage_id, 'S01');
    assert.equal(s01.depends_on, '`PROPOSE_READY` + clean Git baseline');
    assert.equal(s01.goal, 'MES durable facts 基础：闭集 fact envelope、root-bound snapshot store');
    assert.equal(s01.entry_criteria, '`PROPOSE_READY` 已确认；四类 canonical Authority 完整');
    assert.equal(
      s01.authority_refs,
      'PRD#FR-003/004/005/009/011；architecture#HP-001/004/006/007/010、ADR-009/010/011',
    );

    // Closed field set — exactly the five typed fields, never a readiness field.
    for (const entry of entries) {
      assert.equal('readiness' in entry, false, 'typed entry must not carry a readiness field (STATIC-22)');
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['authority_refs', 'depends_on', 'entry_criteria', 'goal', 'stage_id'],
        'entry field set must be exactly the closed five fields',
      );
    }

    // The vnext public seam exports the same pure functions.
    const seamEntries = parseStageMapFromSeam(CANONICAL_MAP);
    assert.deepEqual(seamEntries, entries);
    assert.equal(resolveStageMapEntryFromSeam(CANONICAL_MAP, S02_REF).stage_id, 'S02');
  });

  test('resolves the stage map entry from a thin plan map ref or fails closed', () => {
    // Valid ref resolves the current entry on the same Map basis.
    const s02 = resolveStageMapEntry(CANONICAL_MAP, S02_REF);
    assert.equal(s02.stage_id, 'S02');
    assert.ok(s02.depends_on.includes('STAGE_ACCEPTED'));
    assert.equal(s02.authority_refs.length > 0, true);

    // Unknown entry id -> typed PLAN_GAP-style failure.
    assert.throws(
      () => resolveStageMapEntry(CANONICAL_MAP, `${CANONICAL_PROJECT_STAGE_MAP_PATH}#S99`),
      (err: unknown) =>
        err instanceof StageMapResolutionError &&
        err.code === 'MAP_UNKNOWN_ENTRY',
    );

    // Invalid map refs (non-canonical path / non-canonical stage entry).
    const expectRefInvalid = (ref: string) =>
      assert.throws(
        () => resolveStageMapEntry(CANONICAL_MAP, ref),
        (err: unknown) =>
          err instanceof StageMapResolutionError &&
          err.code === 'MAP_REF_INVALID' &&
          err.stageRef === ref,
      );
    expectRefInvalid('not-a-ref');
    expectRefInvalid('delivery/other.md#S02');
    expectRefInvalid(`${CANONICAL_PROJECT_STAGE_MAP_PATH}#S02x`);
    expectRefInvalid(`${CANONICAL_PROJECT_STAGE_MAP_PATH}#`);

    // Missing / empty artifact (no Map text on this basis).
    assert.throws(
      () => parseStageMap(''),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MISSING',
    );
    assert.throws(
      () => resolveStageMapEntry('   \n \n', S02_REF),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MISSING',
    );

    // Duplicate stage id -> fail closed at parse AND resolution.
    const duplicateMap = `${CANONICAL_MAP}\n| S02 | duplicated | duplicated goal | duplicated criteria | duplicated refs |\n`;
    assert.throws(
      () => parseStageMap(duplicateMap),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_DUPLICATE_ENTRY',
    );
    assert.throws(
      () => resolveStageMapEntry(duplicateMap, S02_REF),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_DUPLICATE_ENTRY',
    );

    // Bad table shape: wrong header set, missing separator, short row,
    // non-canonical stage cell, no entries.
    const wrongHeader = CANONICAL_MAP.replace(MAP_HEADER, '| Stage | depends_on | goal | entry criteria | Authority refs |');
    assert.throws(
      () => parseStageMap(wrongHeader),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MALFORMED',
    );

    const missingSeparator = `${MAP_HEADER}\n| S01 | \`PROPOSE_READY\` + clean Git baseline | goal | criteria | refs |\n`;
    assert.throws(
      () => parseStageMap(missingSeparator),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MALFORMED',
    );

    const shortRow = `${MAP_HEADER}\n${MAP_SEPARATOR}\n| S01 | only-two-cells |\n`;
    assert.throws(
      () => parseStageMap(shortRow),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MALFORMED',
    );

    const badStageCell = `${MAP_HEADER}\n${MAP_SEPARATOR}\n| S02x | dep | goal | criteria | refs |\n`;
    assert.throws(
      () => parseStageMap(badStageCell),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MALFORMED',
    );

    const emptyCell = `${MAP_HEADER}\n${MAP_SEPARATOR}\n| S01 | dep | goal |  | refs |\n`;
    assert.throws(
      () => parseStageMap(emptyCell),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MALFORMED',
    );

    const noEntries = `${MAP_HEADER}\n${MAP_SEPARATOR}\n`;
    assert.throws(
      () => parseStageMap(noEntries),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_MALFORMED',
    );

    // An operational-readiness column is NOT a Map field (STATIC-22).
    const readinessColumn = '| Stage | depends_on | 目标（独立交付 outcome） | entry criteria | Authority refs | 当前 readiness |\n'
      + '|---|---|---|---|---|---|\n'
      + '| S01 | dep | goal | criteria | refs | ready |\n';
    assert.throws(
      () => parseStageMap(readinessColumn),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_READINESS_CACHE',
    );
    assert.throws(
      () => resolveStageMapEntry(readinessColumn, S02_REF),
      (err: unknown) =>
        err instanceof StageMapResolutionError && err.code === 'MAP_READINESS_CACHE',
    );
  });
});

// Reference the type so the closed error-code union stays bound to the API.
export type { StageMapEntry, StageMapResolutionErrorCode };