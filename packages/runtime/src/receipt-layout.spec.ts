/**
 * receiptLayout — PO-S02-C-05 (contract part)
 *
 * Verifies the canonical receipt category directory layout policy of
 * @proofloop/runtime (runtime-owned Artifact Path Policy):
 *
 *   <projectRoot>/.proofloop/receipts/
 *     plan/<stage>/            SLICE_PLAN, STAGE_PLAN, SPV_PASS
 *     tasks/<stage>/<slice>/   TASK_COMPLETE
 *     cv/<stage>/<slice>/      CV_PASS, CV_REPAIR
 *     committer/<stage>/<slice>/  SLICE_COMMIT
 *     integration/<stage>/<slice>/ INTEGRATION_PASS
 *     stage-gate/<stage>/      GATE_PASS, GATE_FAIL
 *     review/<stage>/          STAGE_REVIEW_PASS
 *     project/                 PROJECT_REVIEW_PASS
 *     .tmp/                    scratch — never a receipt source
 *
 * Expected path segments are written as known-good literals (independent of
 * the implementation). The type→category classification is the closed 12-type
 * receipt set mapped onto the 8 content categories — every type belongs to
 * exactly one category, no category is empty.
 *
 * Policy note (asserted below): SPV_PASS is classified under `plan/<stage>/` —
 * it is the stage-plan semantic proof verification pass (plan lifecycle:
 * STAGE_PLAN → SPV_PASS), matching deriveStageState's stage-boundary trio.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import type { ReceiptType } from '@proofloop/kernel';
import {
  RECEIPT_CATEGORIES,
  RECEIPT_CONTENT_CATEGORIES,
  RECEIPT_TYPE_CATEGORY,
  RECEIPT_TYPES_BY_CATEGORY,
  receiptsRoot,
  receiptLayout,
  receiptCategoryDir,
  planReceiptDir,
  tasksReceiptDir,
  cvReceiptDir,
  committerReceiptDir,
  integrationReceiptDir,
  stageGateReceiptDir,
  reviewReceiptDir,
  projectReceiptDir,
  tmpReceiptDir,
} from '@proofloop/runtime';

const ROOT = '/fixture/project';
const STAGE = 'S02';
const SLICE = 'S02-C';

/** The closed 13-type receipt set (§4 / §5 canonical type registry, incl. the S05 additive GATE_INTERRUPTED). */
const ALL_RECEIPT_TYPES: readonly ReceiptType[] = [
  'SLICE_PLAN',
  'STAGE_PLAN',
  'SPV_PASS',
  'TASK_COMPLETE',
  'CV_PASS',
  'CV_REPAIR',
  'SLICE_COMMIT',
  'INTEGRATION_PASS',
  'GATE_PASS',
  'GATE_FAIL',
  'GATE_INTERRUPTED',
  'STAGE_REVIEW_PASS',
  'PROJECT_REVIEW_PASS',
];

describe('receiptLayout — canonical category directory layout (PO-S02-C-05)', () => {
  it('maps all 9 canonical category directories under .proofloop/receipts', () => {
    const layout = receiptLayout(ROOT, STAGE, SLICE);
    const base = path.join(ROOT, '.proofloop', 'receipts');

    expect(layout.root).toBe(base);
    expect(layout.plan).toBe(path.join(base, 'plan', STAGE));
    expect(layout.tasks).toBe(path.join(base, 'tasks', STAGE, SLICE));
    expect(layout.cv).toBe(path.join(base, 'cv', STAGE, SLICE));
    expect(layout.committer).toBe(path.join(base, 'committer', STAGE, SLICE));
    expect(layout.integration).toBe(path.join(base, 'integration', STAGE, SLICE));
    expect(layout.stageGate).toBe(path.join(base, 'stage-gate', STAGE));
    expect(layout.review).toBe(path.join(base, 'review', STAGE));
    expect(layout.project).toBe(path.join(base, 'project'));
    expect(layout.tmp).toBe(path.join(base, 'tmp'));
  });

  it('exposes the closed category set: 8 content categories + tmp', () => {
    expect([...RECEIPT_CATEGORIES]).toEqual([
      'plan',
      'tasks',
      'cv',
      'committer',
      'integration',
      'stage-gate',
      'review',
      'project',
      'tmp',
    ]);
    expect([...RECEIPT_CONTENT_CATEGORIES]).toEqual([
      'plan',
      'tasks',
      'cv',
      'committer',
      'integration',
      'stage-gate',
      'review',
      'project',
    ]);
  });

  it('resolves every category via receiptCategoryDir consistently with the dedicated helpers', () => {
    expect(receiptsRoot(ROOT)).toBe(path.join(ROOT, '.proofloop', 'receipts'));
    expect(receiptCategoryDir(ROOT, 'plan', STAGE)).toBe(planReceiptDir(ROOT, STAGE));
    expect(receiptCategoryDir(ROOT, 'tasks', STAGE, SLICE)).toBe(tasksReceiptDir(ROOT, STAGE, SLICE));
    expect(receiptCategoryDir(ROOT, 'cv', STAGE, SLICE)).toBe(cvReceiptDir(ROOT, STAGE, SLICE));
    expect(receiptCategoryDir(ROOT, 'committer', STAGE, SLICE)).toBe(
      committerReceiptDir(ROOT, STAGE, SLICE),
    );
    expect(receiptCategoryDir(ROOT, 'integration', STAGE, SLICE)).toBe(
      integrationReceiptDir(ROOT, STAGE, SLICE),
    );
    expect(receiptCategoryDir(ROOT, 'stage-gate', STAGE)).toBe(stageGateReceiptDir(ROOT, STAGE));
    expect(receiptCategoryDir(ROOT, 'review', STAGE)).toBe(reviewReceiptDir(ROOT, STAGE));
    expect(receiptCategoryDir(ROOT, 'project')).toBe(projectReceiptDir(ROOT));
    expect(receiptCategoryDir(ROOT, 'tmp')).toBe(tmpReceiptDir(ROOT));
  });

  it('classifies every one of the 13 receipt types into exactly one content category', () => {
    const seen = new Map<ReceiptType, string>();
    for (const type of ALL_RECEIPT_TYPES) {
      const category = RECEIPT_TYPE_CATEGORY[type];
      expect(RECEIPT_CONTENT_CATEGORIES).toContain(category);
      seen.set(type, category);
    }
    // Expected classification per the canonical layout (known-good literals):
    expect(seen.get('SLICE_PLAN')).toBe('plan');
    expect(seen.get('STAGE_PLAN')).toBe('plan');
    expect(seen.get('SPV_PASS')).toBe('plan');
    expect(seen.get('TASK_COMPLETE')).toBe('tasks');
    expect(seen.get('CV_PASS')).toBe('cv');
    expect(seen.get('CV_REPAIR')).toBe('cv');
    expect(seen.get('SLICE_COMMIT')).toBe('committer');
    expect(seen.get('INTEGRATION_PASS')).toBe('integration');
    expect(seen.get('GATE_PASS')).toBe('stage-gate');
    expect(seen.get('GATE_FAIL')).toBe('stage-gate');
    expect(seen.get('GATE_INTERRUPTED')).toBe('stage-gate');
    expect(seen.get('STAGE_REVIEW_PASS')).toBe('review');
    expect(seen.get('PROJECT_REVIEW_PASS')).toBe('project');
  });

  it('derives RECEIPT_TYPES_BY_CATEGORY as the inverse of the type→category map', () => {
    for (const category of RECEIPT_CONTENT_CATEGORIES) {
      const types = RECEIPT_TYPES_BY_CATEGORY[category];
      expect(types.length).toBeGreaterThan(0);
      for (const type of types) {
        expect(RECEIPT_TYPE_CATEGORY[type]).toBe(category);
      }
    }
    // Every receipt type appears exactly once across all categories.
    const all = RECEIPT_CONTENT_CATEGORIES.flatMap((c) => [...RECEIPT_TYPES_BY_CATEGORY[c]]);
    expect(all).toHaveLength(ALL_RECEIPT_TYPES.length);
    expect(new Set(all).size).toBe(ALL_RECEIPT_TYPES.length);
    expect([...new Set(all)].sort()).toEqual([...ALL_RECEIPT_TYPES].sort());
  });

  it('never maps any receipt type to the .tmp scratch category', () => {
    for (const type of ALL_RECEIPT_TYPES) {
      expect(RECEIPT_TYPE_CATEGORY[type]).not.toBe('tmp');
    }
  });

  it('GATE_INTERRUPTED (S05 additive 13th type) belongs to stage-gate alongside GATE_PASS/GATE_FAIL', () => {
    expect(RECEIPT_TYPE_CATEGORY['GATE_INTERRUPTED']).toBe('stage-gate');
    expect(RECEIPT_TYPES_BY_CATEGORY['stage-gate']).toContain('GATE_INTERRUPTED');
    // the existing 12-type membership is unchanged
    expect(RECEIPT_TYPES_BY_CATEGORY['stage-gate']).toContain('GATE_PASS');
    expect(RECEIPT_TYPES_BY_CATEGORY['stage-gate']).toContain('GATE_FAIL');
    // no type maps to two categories and no category holds a foreign type
    const all = RECEIPT_CONTENT_CATEGORIES.flatMap((c) => [...RECEIPT_TYPES_BY_CATEGORY[c]]);
    expect(new Set(all).size).toBe(13);
  });
});
