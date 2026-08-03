/**
 * @proofloop/runtime — Canonical receipt category directory layout (PO-S02-C-05)
 *
 * The runtime-owned Artifact Path Policy: all persisted receipts live under
 * `<projectRoot>/.proofloop/receipts/` in one of eight canonical content
 * category directories, plus a `.tmp/` scratch directory that is NEVER read
 * as a receipt source:
 *
 *   plan/<stage>/            SLICE_PLAN, STAGE_PLAN, SPV_PASS
 *   tasks/<stage>/<slice>/   TASK_COMPLETE
 *   cv/<stage>/<slice>/      CV_PASS, CV_REPAIR
 *   committer/<stage>/<slice>/  SLICE_COMMIT
 *   integration/<stage>/<slice>/ INTEGRATION_PASS
 *   stage-gate/<stage>/      GATE_PASS, GATE_FAIL, GATE_INTERRUPTED
 *   review/<stage>/          STAGE_REVIEW_PASS
 *   project/                 PROJECT_REVIEW_PASS, PROJECT_E2E_PASS,
 *                            PROJECT_E2E_FAIL, PROJECT_E2E_BLOCKED
 *   .tmp/                    scratch — never a receipt source
 *
 * Reconcile (S02-C-T03) reads ONLY this layout; the kernel ReceiptWriter
 * (S01) writes into it; kernel `verifyReceiptChain` runs per category
 * directory (each directory holds its own independent chain, PO-S02-C-03).
 *
 * Policy note: `SPV_PASS` (the stage-plan semantic proof verification pass)
 * is classified under `plan/<stage>/` — it is the plan-lifecycle receipt
 * (STAGE_PLAN → SPV_PASS), matching deriveStageState's stage-boundary trio
 * STAGE_PLAN / SPV_PASS / STAGE_REVIEW_PASS.
 *
 * Determinism (HP-003): all path resolution is pure `path.join` over the
 * canonical segment names — no I/O, no timestamps, no locale-dependent
 * ordering.
 */

import * as path from 'node:path';
import type { ReceiptType } from '@proofloop/kernel';

// ============================================================
// Category closed sets
// ============================================================

/** Receipt category directory names (closed set, canonical). */
export type ReceiptCategory =
  | 'plan'
  | 'tasks'
  | 'cv'
  | 'committer'
  | 'integration'
  | 'stage-gate'
  | 'review'
  | 'project'
  | 'tmp';

/** Content categories that may hold receipt files (excludes `.tmp`). */
export type ReceiptContentCategory = Exclude<ReceiptCategory, 'tmp'>;

/** Closed set of all 9 category directory names. */
export const RECEIPT_CATEGORIES: readonly ReceiptCategory[] = [
  'plan',
  'tasks',
  'cv',
  'committer',
  'integration',
  'stage-gate',
  'review',
  'project',
  'tmp',
] as const;

/** Closed set of the 8 content categories (never `.tmp`). */
export const RECEIPT_CONTENT_CATEGORIES: readonly ReceiptContentCategory[] = [
  'plan',
  'tasks',
  'cv',
  'committer',
  'integration',
  'stage-gate',
  'review',
  'project',
] as const;

// ============================================================
// Path resolution
// ============================================================

/** Canonical receipts root: `<projectRoot>/.proofloop/receipts`. */
export function receiptsRoot(projectRoot: string): string {
  return path.join(projectRoot, '.proofloop', 'receipts');
}

/** `plan/<stage>/` — SLICE_PLAN, STAGE_PLAN, SPV_PASS. */
export function planReceiptDir(projectRoot: string, stageId: string): string {
  return path.join(receiptsRoot(projectRoot), 'plan', stageId);
}

/** `tasks/<stage>/<slice>/` — TASK_COMPLETE. */
export function tasksReceiptDir(projectRoot: string, stageId: string, sliceId: string): string {
  return path.join(receiptsRoot(projectRoot), 'tasks', stageId, sliceId);
}

/** `cv/<stage>/<slice>/` — CV_PASS, CV_REPAIR. */
export function cvReceiptDir(projectRoot: string, stageId: string, sliceId: string): string {
  return path.join(receiptsRoot(projectRoot), 'cv', stageId, sliceId);
}

/** `committer/<stage>/<slice>/` — SLICE_COMMIT. */
export function committerReceiptDir(projectRoot: string, stageId: string, sliceId: string): string {
  return path.join(receiptsRoot(projectRoot), 'committer', stageId, sliceId);
}

/** `integration/<stage>/<slice>/` — INTEGRATION_PASS. */
export function integrationReceiptDir(projectRoot: string, stageId: string, sliceId: string): string {
  return path.join(receiptsRoot(projectRoot), 'integration', stageId, sliceId);
}

/** `stage-gate/<stage>/` — GATE_PASS, GATE_FAIL, GATE_INTERRUPTED. */
export function stageGateReceiptDir(projectRoot: string, stageId: string): string {
  return path.join(receiptsRoot(projectRoot), 'stage-gate', stageId);
}

/** `review/<stage>/` — STAGE_REVIEW_PASS. */
export function reviewReceiptDir(projectRoot: string, stageId: string): string {
  return path.join(receiptsRoot(projectRoot), 'review', stageId);
}

/** `project/` — PROJECT_REVIEW_PASS. */
export function projectReceiptDir(projectRoot: string): string {
  return path.join(receiptsRoot(projectRoot), 'project');
}

/** `.tmp/` — scratch, never read as receipts. */
export function tmpReceiptDir(projectRoot: string): string {
  return path.join(receiptsRoot(projectRoot), 'tmp');
}

/**
 * Fail-closed guard for missing required path parameters.
 *
 * Stage-level categories (`plan`, `stage-gate`, `review`) require `stageId`;
 * slice-level categories (`tasks`, `cv`, `committer`, `integration`) require
 * both `stageId` and `sliceId`. Missing identifiers throw a TypeError instead
 * of silently producing an ambiguous path (HP-003: never guess).
 */
function requireId(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new TypeError(`receiptCategoryDir: ${label} is required for this category`);
  }
  return value;
}

/**
 * Resolve the directory for a category.
 *
 * Stage-level categories (`plan`, `stage-gate`, `review`) require `stageId`;
 * slice-level categories (`tasks`, `cv`, `committer`, `integration`) require
 * both `stageId` and `sliceId`; `project` and `tmp` require neither.
 *
 * @throws {TypeError} when a required stage/slice id is missing.
 */
export function receiptCategoryDir(
  projectRoot: string,
  category: ReceiptCategory,
  stageId?: string,
  sliceId?: string,
): string {
  switch (category) {
    case 'plan':
      return planReceiptDir(projectRoot, requireId(stageId, 'stageId'));
    case 'tasks':
      return tasksReceiptDir(
        projectRoot,
        requireId(stageId, 'stageId'),
        requireId(sliceId, 'sliceId'),
      );
    case 'cv':
      return cvReceiptDir(
        projectRoot,
        requireId(stageId, 'stageId'),
        requireId(sliceId, 'sliceId'),
      );
    case 'committer':
      return committerReceiptDir(
        projectRoot,
        requireId(stageId, 'stageId'),
        requireId(sliceId, 'sliceId'),
      );
    case 'integration':
      return integrationReceiptDir(
        projectRoot,
        requireId(stageId, 'stageId'),
        requireId(sliceId, 'sliceId'),
      );
    case 'stage-gate':
      return stageGateReceiptDir(projectRoot, requireId(stageId, 'stageId'));
    case 'review':
      return reviewReceiptDir(projectRoot, requireId(stageId, 'stageId'));
    case 'project':
      return projectReceiptDir(projectRoot);
    case 'tmp':
      return tmpReceiptDir(projectRoot);
  }
}

/** Full deterministic layout map for one stage/slice context. */
export interface ReceiptLayout {
  /** `<projectRoot>/.proofloop/receipts`. */
  readonly root: string;
  /** `plan/<stage>/`. */
  readonly plan: string;
  /** `tasks/<stage>/<slice>/`. */
  readonly tasks: string;
  /** `cv/<stage>/<slice>/`. */
  readonly cv: string;
  /** `committer/<stage>/<slice>/`. */
  readonly committer: string;
  /** `integration/<stage>/<slice>/`. */
  readonly integration: string;
  /** `stage-gate/<stage>/`. */
  readonly stageGate: string;
  /** `review/<stage>/`. */
  readonly review: string;
  /** `project/`. */
  readonly project: string;
  /** `.tmp/` scratch. */
  readonly tmp: string;
}

/** Deterministic layout map for one stage/slice context (PO-S02-C-05). */
export function receiptLayout(
  projectRoot: string,
  stageId: string,
  sliceId: string,
): ReceiptLayout {
  return {
    root: receiptsRoot(projectRoot),
    plan: planReceiptDir(projectRoot, stageId),
    tasks: tasksReceiptDir(projectRoot, stageId, sliceId),
    cv: cvReceiptDir(projectRoot, stageId, sliceId),
    committer: committerReceiptDir(projectRoot, stageId, sliceId),
    integration: integrationReceiptDir(projectRoot, stageId, sliceId),
    stageGate: stageGateReceiptDir(projectRoot, stageId),
    review: reviewReceiptDir(projectRoot, stageId),
    project: projectReceiptDir(projectRoot),
    tmp: tmpReceiptDir(projectRoot),
  };
}

// ============================================================
// Receipt type → category classification (PO-S02-C-05)
// ============================================================

/**
 * Canonical mapping from each of the 16 receipt types to the content category
 * directory that may hold it. This is the closed-set classification used to
 * detect misplaced receipts (type/category mismatch → RUNTIME.SCHEMA_MISMATCH).
 *
 * The mapping is total: every one of the 16 receipt types maps to exactly one
 * content category, and no type maps to the `.tmp` scratch directory.
 *
 * B1c (blueprint §6.4 `run_e2e`): PROJECT_E2E_PASS / PROJECT_E2E_FAIL /
 * PROJECT_E2E_BLOCKED are the additive project-level E2E gate verdict
 * receipts. They live in the shared `project/` category (alongside
 * PROJECT_REVIEW_PASS) but are EVIDENCE-only artifacts: finalize reads and
 * cross-validates them; reconcile never derives project_state from them (only
 * PROJECT_REVIEW_PASS triggers COMPLETED — a FAILED E2E run can never
 * prematurely complete the project).
 */
export const RECEIPT_TYPE_CATEGORY: Readonly<Record<ReceiptType, ReceiptContentCategory>> = {
  SLICE_PLAN: 'plan',
  STAGE_PLAN: 'plan',
  SPV_PASS: 'plan',
  TASK_COMPLETE: 'tasks',
  CV_PASS: 'cv',
  CV_REPAIR: 'cv',
  SLICE_COMMIT: 'committer',
  INTEGRATION_PASS: 'integration',
  GATE_PASS: 'stage-gate',
  GATE_FAIL: 'stage-gate',
  GATE_INTERRUPTED: 'stage-gate',
  STAGE_REVIEW_PASS: 'review',
  PROJECT_REVIEW_PASS: 'project',
  PROJECT_E2E_PASS: 'project',
  PROJECT_E2E_FAIL: 'project',
  PROJECT_E2E_BLOCKED: 'project',
};

/**
 * Inverse map: content category → allowed receipt types.
 *
 * Derived deterministically from `RECEIPT_TYPE_CATEGORY` (single source of
 * truth); each category's list is sorted so the derived structure is stable.
 */
function buildTypesByCategory(): Readonly<
  Record<ReceiptContentCategory, readonly ReceiptType[]>
> {
  const buckets: Record<ReceiptContentCategory, ReceiptType[]> = {
    plan: [],
    tasks: [],
    cv: [],
    committer: [],
    integration: [],
    'stage-gate': [],
    review: [],
    project: [],
  };
  for (const type of Object.keys(RECEIPT_TYPE_CATEGORY) as ReceiptType[]) {
    buckets[RECEIPT_TYPE_CATEGORY[type]].push(type);
  }
  for (const category of Object.keys(buckets) as ReceiptContentCategory[]) {
    buckets[category].sort();
  }
  return buckets;
}

/** Inverse map: content category → ordered list of allowed receipt types. */
export const RECEIPT_TYPES_BY_CATEGORY: Readonly<
  Record<ReceiptContentCategory, readonly ReceiptType[]>
> = buildTypesByCategory();
