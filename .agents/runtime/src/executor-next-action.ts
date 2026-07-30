/**
 * executor-next-action.ts
 *
 * One-step path-type interface that combines Reconcile and Derive.
 *
 * The Executor writes only a path-only ReconcileStageStateInput JSON file,
 * runs this tool, and executes exactly the returned action.  No intermediate
 * DeriveNextActionInput construction by the Executor.
 *
 * CLI:
 *   node dist/executor-next-action.js <reconcile-input.json>
 *
 * Input (path-only):
 *   {
 *     "stage_id": "S01",
 *     "project_root": ".",
 *     "manifest_path": ".proofloop/manifests/S01.json",
 *     "tasks_path": "delivery/stages/S01/tasks.md",
 *     "stage_gate_receipt_path": ".proofloop/receipts/stage-gate/S01/stage-gate-S01.json"
 *   }
 *
 * Output:
 *   {
 *     "stage_id": "S01",
 *     "manifest_digest": "...",
 *     "action": { "action_type": "implement", "slice_id": "S01-A", ... }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileStageState, ReconcileStageStateInput } from './reconcile-stage-state.js';
import { deriveNextAction } from './derive-next-action.js';
import type { NextAction } from './derive-next-action.js';

// ── Public interface ──────────────────────────────────────────────────────────

export interface ExecutorNextActionResult {
  /** Stage ID from the reconciled stage state. */
  stage_id: string;
  /** Canonical manifest digest computed during reconciliation. */
  manifest_digest?: string;
  /** The single deterministic next action derived from the reconciled state. */
  action: NextAction;
}

/**
 * Resolve the next executor action in one step.
 *
 * Combines reconcileStageState (reads all persisted files and Git state) with
 * deriveNextAction (state machine) into a single call.  The Executor only needs
 * to provide path-only input — no intermediate state construction required.
 *
 * @param input - Path-only ReconcileStageStateInput.
 * @returns The resolved stage ID, manifest digest, and next action.
 */
export function resolveExecutorNextAction(
  input: ReconcileStageStateInput,
): ExecutorNextActionResult {
  const state = reconcileStageState(input);
  const action = deriveNextAction(state);

  return {
    stage_id: state.stage_id ?? input.stage_id,
    manifest_digest: state.manifest_digest,
    action,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

function isScriptEntry(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  try {
    const resolved = path.resolve(scriptPath);
    const currentFile = fileURLToPath(import.meta.url);
    return resolved === currentFile;
  } catch {
    const base = path.basename(scriptPath);
    return base === 'executor-next-action.js' || base === 'executor-next-action.ts';
  }
}

if (isScriptEntry()) {
  const inputPath = process.argv[2];

  if (!inputPath) {
    console.error('Usage: node dist/executor-next-action.js <reconcile-input.json>');
    console.error('');
    console.error('Reads a path-only ReconcileStageStateInput JSON file and outputs');
    console.error('the resolved ExecutorNextActionResult JSON to stdout.');
    console.error('');
    console.error('Required input fields:');
    console.error('  stage_id (string)');
    console.error('  project_root (string)');
    console.error('  manifest_path (string)');
    console.error('  tasks_path (string)');
    console.error('');
    console.error('Optional input fields:');
    console.error('  stage_gate_receipt_path (string)');
    process.exit(1);
  }

  let input: ReconcileStageStateInput;
  try {
    const raw = fs.readFileSync(inputPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Minimal validation
    if (
      typeof parsed.stage_id !== 'string' ||
      typeof parsed.project_root !== 'string' ||
      typeof parsed.manifest_path !== 'string' ||
      typeof parsed.tasks_path !== 'string'
    ) {
      throw new Error(
        'Input must contain stage_id (string), project_root (string), ' +
        'manifest_path (string), and tasks_path (string).',
      );
    }
    input = parsed as ReconcileStageStateInput;
  } catch (err) {
    console.error(
      `Error reading input: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  try {
    const result = resolveExecutorNextAction(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(
      `Error resolving executor next action: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(err);
    process.exit(1);
  }
}
