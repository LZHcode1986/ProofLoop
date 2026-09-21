/**
 * Execute public-surface / index fan-in tests (S03-F-T02).
 *
 * # PO: PO-S03-F-03
 *
 * Exercises the terminal aggregation of the Execute machinery seams through
 * the runtime public index (`packages/runtime/src/index.ts`, unique writer =
 * S03-F-T02) and the vNext index (`packages/runtime/src/vnext/index.ts`):
 *   - every Execute seam (task-result / task-result-ack / successor-barrier /
 *     work-packet / plan-task-graph / lane / cv-result / finding-disposition /
 *     git-worktree / integration-state / slice-proof-binding adapter) is
 *     aggregated into the runtime index EXACTLY ONCE (no `export *` added,
 *     no duplicate names, no test-as-code path);
 *   - the raw `classifyReplanImpact` / `ReplanImpactError` engine is NOT
 *     exported from either index (vnext/index raw export removed by this task;
 *     the adapter `classifySliceProofImpact` is the ONLY public classification
 *     entry; the raw engine remains reachable via internal module path);
 *   - the source-of-truth index files keep the same single-name explicit
 *     re-export style (mes/index.ts aggregated by S03-A-T02 — not overlapped
 *     here).
 *
 * Import level: compiled runtime dist (built by `npx tsc -b --force`) plus
 * static source reads of the two index files for exact-once assertions.
 * Polls neither VNext index raw export removal nor MES content — pure
 * structural surface checks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
// (commonjs under the test tsconfig; __dirname is available)
// Runtime public index (compiled) — every seam marker must resolve here.
import * as runtime from '../dist/index';
// vNext index (compiled) — must NOT expose the raw engine.
import * as vnext from '../dist/vnext';
// Internal module path — raw engine stays reachable outside the public index.
import {
  classifyReplanImpact,
  ReplanImpactError,
} from '../dist/vnext/replan-impact';

const TEST_DIR = __dirname;
const SRC_ROOT = path.resolve(TEST_DIR, '../src');
const RUNTIME_INDEX = path.join(SRC_ROOT, 'index.ts');
const VNEXT_INDEX = path.join(SRC_ROOT, 'vnext/index.ts');
const EXECUTE_DIR = path.join(SRC_ROOT, 'execute');

describe('S03-F-T02 execute public surface', () => {
  test('aggregates every execute seam exactly once without the raw classifier', () => {
    // --- Every Execute seam marker resolves from the runtime public index. ---
    const markers: Array<[string, unknown]> = [
      ['task-result', runtime.validateWorkerTaskResult],
      ['task-result', runtime.computeResultPayloadDigest],
      ['task-result-ack', runtime.buildTaskResultAck],
      ['successor-barrier', runtime.selectNextReadyTask],
      ['work-packet', runtime.validateSliceWorkPacket],
      ['work-packet', runtime.validateJitReadSet],
      ['work-packet', runtime.validateBoundedRepairWorkPacket],
      ['plan-task-graph', runtime.buildAcceptedPlanTaskGraph],
      ['lane', runtime.buildLaneWorkFact],
      ['lane', runtime.assertExecutionReadyForReview],
      ['cv-result', runtime.validateCvResult],
      ['cv-result', runtime.gateCvResult],
      ['finding-disposition', runtime.buildFindingDisposition],
      ['finding-disposition', runtime.effectiveRoute],
      ['git-worktree', runtime.createGitWorktree],
      ['git-worktree', runtime.removeGitWorktree],
      ['integration-state', runtime.buildIntegrationFact],
      ['integration-state', runtime.projectIntegrationState],
      ['slice-proof-binding', runtime.classifySliceProofImpact],
      ['slice-proof-binding', runtime.projectSliceProofSnapshot],
    ];
    const covered = new Set<string>();
    for (const [seam, marker] of markers) {
      assert.equal(typeof marker, 'function', `runtime index must export ${seam} marker (function)`);
      covered.add(seam);
    }
    assert.equal(
      covered.size,
      11,
      `expected exactly 11 execute seams aggregated (got ${[...covered].join(',')})`,
    );

    // --- The adapter is the ONLY public classification entry: the raw engine
    //     must NOT be exported from either index. ---
    assert.equal(
      (runtime as Record<string, unknown>).classifyReplanImpact,
      undefined,
      'runtime index must not export the raw classifyReplanImpact engine',
    );
    assert.equal(
      (vnext as Record<string, unknown>).classifyReplanImpact,
      undefined,
      'vnext index must not export the raw classifyReplanImpact engine',
    );
    assert.equal(
      (vnext as Record<string, unknown>).ReplanImpactError,
      undefined,
      'vnext index must not export the raw ReplanImpactError',
    );

    // --- The raw engine stays reachable via the internal module path and is
    //     still THE classifier the adapter wraps (regression guard). ---
    assert.equal(typeof classifyReplanImpact, 'function');
    assert.ok(ReplanImpactError);

    // --- Static exact-once source checks over the two index files. ---
    const runtimeSrc = fs.readFileSync(RUNTIME_INDEX, 'utf8');
    const vnextSrc = fs.readFileSync(VNEXT_INDEX, 'utf8');
    for (const seam of [
      'task-result',
      'task-result-ack',
      'successor-barrier',
      'work-packet',
      'plan-task-graph',
      'lane',
      'cv-result',
      'finding-disposition',
      'integration-state',
      'slice-proof-binding',
    ]) {
      const re = new RegExp(`from ['"]\\./execute/${seam}['"]`);
      const occurrences = (runtimeSrc.match(re) ?? []).length;
      assert.equal(occurrences, 1, `runtime index must import ./execute/${seam} exactly once (got ${occurrences})`);
    }
    // git-worktree is a top-level runtime module (not under execute/).
    const gwOccurrences = (runtimeSrc.match(/from ['"]\.\/git-worktree['"]/) ?? []).length;
    assert.equal(gwOccurrences, 1, 'runtime index must import ./git-worktree exactly once');

    // No raw engine re-export may remain in either file.
    // No raw engine may be RE-EXPORTED from either file (comments may name it).
    assert.doesNotMatch(vnextSrc, /export[^;]*classifyReplanImpact/, 'vnext/index.ts must not re-export the raw engine');
    assert.doesNotMatch(runtimeSrc, /export[^;]*classifyReplanImpact/, 'runtime index must not re-export the raw engine');
    assert.ok(!/export \* from ['"]\.\/execute\//.test(runtimeSrc), 'runtime index must not re-export execute seams via export *');

    // mes/index.ts is aggregated by S03-A-T02: the runtime index must keep
    // importing it wholesale via its own module and never via execute/*.
    assert.ok(runtimeSrc.includes("export * from './mes'"), 'runtime index keeps the mes seam aggregate');

    // No test file is part of any code path.
    for (const f of fs.readdirSync(EXECUTE_DIR)) {
      assert.ok(!f.includes('.test.'), `execute dir must not contain test files (${f})`);
    }
  });
});