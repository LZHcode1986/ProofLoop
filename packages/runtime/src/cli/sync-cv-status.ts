/**
 * sync-cv-status — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Reconcile → derive the current CV status of a slice (READ-ONLY — the CLI
 * never writes the evidence file; the Executor is the sole writer of
 * `## Current CV Status`). Legacy-compatible argument shape (file path or
 * inline `--json`):
 *
 *   node packages/runtime/dist/cli/sync-cv-status.js <options.json>
 *   node packages/runtime/dist/cli/sync-cv-status.js --json '<json>'
 *
 * Options (old field names `deliveryRoot`/`evidencePath` accepted as
 * aliases):
 *   { "stageId": "S03", "sliceId": "S03-H", "projectRoot": ".",
 *     "manifestPath"?, "tasksPath"? }
 *
 * Output JSON:
 *   { success, stage_id, slice_id, slice_state, cv_status, cv_level,
 *     latest_cv_receipt, repair_attempt, slice_evidence_finalized,
 *     evidence_file_present, open_finding, findings }
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding } from '@proofloop/kernel';
import { reconcileStage } from '../reconcile';
import type { ReconcileStageResult } from '../reconcile';
import { manifestSource, ManifestSourceError } from '../manifest-source';

// ============================================================
// Shapes
// ============================================================

export interface SyncCvStatusOptions {
  readonly stageId: string;
  readonly sliceId: string;
  readonly projectRoot: string;
  readonly manifestPath?: string;
  readonly tasksPath?: string;
}

export interface SyncCvStatusOutput {
  readonly success: boolean;
  readonly error?: string;
  readonly stage_id?: string;
  readonly slice_id?: string;
  readonly slice_state?: string;
  readonly cv_status?: string;
  readonly cv_level?: string;
  readonly latest_cv_receipt?:
    | { readonly type: string; readonly digest: string; readonly timestamp: string }
    | null;
  readonly repair_attempt?: number;
  readonly slice_evidence_finalized?: boolean;
  readonly evidence_file_present?: boolean;
  readonly open_finding?: string | null;
  readonly findings?: readonly Finding[];
}

// ============================================================
// Derivation
// ============================================================

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Derive the CV status snapshot of a slice from reconciled persisted facts
 * (read-only — HP-003: every fact comes from the deterministic three-source
 * merge, never a guess).
 */
export function syncCvStatus(options: SyncCvStatusOptions): SyncCvStatusOutput {
  const { stageId, sliceId, projectRoot } = options;
  if (!stageId || !sliceId || !projectRoot) {
    return { success: false, error: 'sync-cv-status requires stageId, sliceId and projectRoot' };
  }
  // Relative manifest/tasks paths resolve inside the project root (legacy
  // path semantics — never outside it).
  const resolveWithin = (p: string | undefined): string | undefined =>
    p === undefined || path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
  const manifestPath = resolveWithin(options.manifestPath);
  const tasksPath = resolveWithin(options.tasksPath);

  let state: ReconcileStageResult;
  try {
    state = reconcileStage({
      projectRoot,
      stageId,
      manifestPath,
      tasksMdPath: tasksPath,
    });
  } catch (err) {
    return {
      success: false,
      error: `reconcile failed for stage "${stageId}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const slice = state.slices.find((s) => s.slice_id === sliceId);
  if (slice === undefined) {
    return {
      success: false,
      error: `slice "${sliceId}" not found in stage "${stageId}"`,
      stage_id: stageId,
      findings: state.findings,
    };
  }

  // CV level + evidence path come from the manifest source (deterministic).
  let cvLevel: string | undefined;
  let evidenceFilePresent: boolean | undefined;
  try {
    const { manifest } = manifestSource({
      projectRoot,
      stageId,
      manifestPath,
    });
    const declared = manifest.slices.find((s) => s.slice_id === sliceId);
    if (declared !== undefined) {
      cvLevel = declared.cv_minimum_level;
      evidenceFilePresent = fs.existsSync(path.join(projectRoot, declared.evidence_path));
    }
  } catch (err) {
    if (!(err instanceof ManifestSourceError)) throw err;
    // manifest unavailable → level/evidence facts stay absent (never a guess)
  }

  const receipt = slice.latest_cv_receipt;
  const latestCvReceipt =
    receipt === null
      ? null
      : { type: receipt.type, digest: receipt.digest, timestamp: receipt.timestamp };
  const openFinding =
    receipt !== null && receipt.type === 'CV_REPAIR'
      ? (typeof receipt.payload?.['summary'] === 'string' && receipt.payload['summary'].length > 0
          ? receipt.payload['summary']
          : 'CV repair required')
      : null;

  return {
    success: true,
    stage_id: stageId,
    slice_id: sliceId,
    slice_state: slice.slice_state,
    cv_status: slice.cv_status,
    cv_level: cvLevel,
    latest_cv_receipt: latestCvReceipt,
    repair_attempt: slice.repair_attempt,
    slice_evidence_finalized: slice.slice_evidence_finalized,
    evidence_file_present: evidenceFilePresent,
    open_finding: openFinding,
    findings: state.findings,
  };
}

// ============================================================
// CLI entry
// ============================================================

/** Read `<options.json>` or `--json '<json>'` (legacy arg contract). */
function readInputArg(argv: readonly string[]): string {
  const [arg1, arg2] = argv;
  if (arg1 === '--json') return arg2 ?? '';
  if (arg1 !== undefined) return fs.readFileSync(arg1, 'utf-8');
  return '';
}

/**
 * Legacy-compatible CLI:
 *   node dist/cli/sync-cv-status.js <options.json>
 *   node dist/cli/sync-cv-status.js --json '<json>'
 */
export function syncCvStatusCli(argv: readonly string[]): number {
  let raw: string;
  try {
    raw = readInputArg(argv);
  } catch (err) {
    console.error(`Error: Cannot read options file: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!raw) {
    console.error('Usage: node dist/cli/sync-cv-status.js <options.json>');
    console.error('       node dist/cli/sync-cv-status.js --json \'<json>\'');
    console.error('');
    console.error('Options JSON:');
    console.error('  { "stageId": "S03", "sliceId": "S03-H", "projectRoot": ".",');
    console.error('    "manifestPath": "optional", "tasksPath": "optional" }');
    console.error('Derives the slice CV status snapshot from reconcile (read-only)');
    console.error('and outputs it as JSON to stdout.');
    return 1;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error(`Error: Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const options: SyncCvStatusOptions = {
    stageId: str(data.stageId) ?? str(data.stage_id) ?? '',
    sliceId: str(data.sliceId) ?? str(data.slice_id) ?? '',
    projectRoot: str(data.projectRoot) ?? str(data.project_root) ?? str(data.deliveryRoot) ?? '',
    manifestPath: str(data.manifestPath) ?? str(data.manifest_path),
    tasksPath: str(data.tasksPath) ?? str(data.tasks_path),
  };
  const output = syncCvStatus(options);
  console.log(JSON.stringify(output, null, 2));
  return output.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = syncCvStatusCli(process.argv.slice(2));
}
