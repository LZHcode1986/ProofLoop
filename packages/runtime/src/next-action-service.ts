/**
 * @proofloop/runtime — NextActionService: the full next-action pipeline
 * (S02-D-T02)
 *
 * `NextActionService` composes the S02-C Reconcile seam with the S02-D-T01
 * pure derivation into the single `nextAction` entry the proofloop_next tool
 * contract (§1 Tool Contracts) consumes:
 *
 *   input { projectRoot, stageId, manifestPath?, tasksPath? }
 *     → reconcileStage (three-source merge; any error-level inconsistency
 *       already lands as a canonical Finding, never a guess)
 *     → chain validation (receipt_chain_valid carried from the reconcile
 *       output — false blocks every execution action in the derive table)
 *     → NextActionExtras built from deterministic persisted facts:
 *         repartition_requested        — manifest canonical field (F-S02-08);
 *         gate_pass_present /
 *         gate_fail_present            — GATE_PASS / GATE_FAIL receipts read
 *                                        from the stage-gate category (facts
 *                                        only from a valid chain, PO-S02-C-03);
 *         evidence_file_present_by_slice — work-tree evidence-file existence
 *                                        per manifest evidence_path;
 *         pending_worker_result_envelopes — result envelopes pending admit in
 *                                        `.pi/proofloop-runtime/results/`
 *                                        (schema-validated, stage-bound);
 *     → deriveNextAction (the pure priority table — the same output the pure
 *       function produces on the same reconcile output)
 *     → wrap into the proofloop_next contract shape (findings capped at the
 *       documented 20-entry tool budget).
 *
 * Determinism (HP-003): every extra is a persisted fact read deterministically
 * (manifest file, sorted receipt dirs, sorted results dir); no timestamps, no
 * randomness, no cache, no process-internal state. The service holds no state
 * — a fresh instance reconciles from scratch, so a Session restart returns the
 * exact same action for the same fixture.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Finding, NextAction, RoleType } from '@proofloop/kernel';
import { reconcileStage } from './reconcile';
import type { ReconcileStageResult } from './reconcile';
import { manifestSource, ManifestSourceError } from './manifest-source';
import { readReceiptCategory } from './receipt-reader';
import { canonicalPathWithinRoot, openNoFollowRead } from './path-guard';
import { validateWorkerResultEnvelope } from './relay-contract';
import type { WorkerResultEnvelope } from './relay-contract';
import { deriveNextAction } from './derive-next-action';
import type { DerivedNextAction, NextActionExtras } from './derive-next-action';

/** Canonical pending-results directory under the project root (contract §4). */
const PENDING_RESULTS_REL = ['.pi', 'proofloop-runtime', 'results'] as const;

/** proofloop_next contract output budget: findings ≤ 20 (contract §1). */
const MAX_FINDINGS = 20;

/** Input to `NextActionService.nextAction` (path → reconcile seam). */
export interface NextActionServiceInput {
  /** Project root (must be the git root when the Git source is available). */
  readonly projectRoot: string;
  /** Stage id to reconcile. */
  readonly stageId: string;
  /** Custom manifest path (defaults to `.proofloop/manifests/<stage>.json`). */
  readonly manifestPath?: string;
  /** Custom tasks.md path (defaults to `delivery/stages/<stage>/tasks.md`). */
  readonly tasksPath?: string;
}

/**
 * proofloop_next-aligned output (§1 Tool Contracts):
 * `action` ∈ 15-value NextAction closed set, non-empty readable
 * `action_detail`, `responsible_role` ∈ 9-value RoleType closed set,
 * boolean `receipt_chain_valid`, `findings` ≤ 20 entries.
 */
export interface NextActionOutput {
  readonly action: NextAction;
  readonly action_detail: string;
  readonly responsible_role: RoleType;
  readonly receipt_chain_valid: boolean;
  readonly findings: Finding[];
}

/**
 * The full Reconcile → Validate → Reduce → Action pipeline.
 *
 * Stateless: every call re-reconciles from the persisted facts, so a fresh
 * instance (Session restart) returns the identical action for the same
 * fixture (HP-003).
 */
export class NextActionService {
  nextAction(input: NextActionServiceInput): NextActionOutput {
    const { projectRoot, stageId } = input;
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      throw new TypeError('NextActionService.nextAction: projectRoot is required');
    }
    if (typeof stageId !== 'string' || stageId.length === 0) {
      throw new TypeError('NextActionService.nextAction: stageId is required');
    }

    // 1. Reconcile — three-source merge (Git + Manifest + Receipts). Any
    //    error-level inconsistency lands here as a canonical Finding (HP-003,
    //    never a guess).
    const reconciled = reconcileStage({
      projectRoot,
      stageId,
      manifestPath: input.manifestPath,
      tasksMdPath: input.tasksPath,
    });

    // 2. Chain validation + deterministic persisted extras.
    const extras = buildExtras(reconciled, input);

    // 3. Unique-action derivation — the pure S02-D-T01 priority table. The
    //    reconcile output IS the pure function's input (PO-S02-D-04); the
    //    extras only add persisted facts Reconcile does not yet carry.
    const derived = deriveNextAction({ ...reconciled, ...extras });

    // 4. proofloop_next contract wrap (findings capped at the tool budget).
    //    For ADMIT_WORKER_RESULT the pure derivation identifies the pending
    //    envelope by slice only; the pipeline appends the envelope's
    //    actionToken — a deterministic persisted fact (the results-dir
    //    filename) — so the output identifies WHICH envelope awaits admit.
    const pendingEnvelopes = extras.pending_worker_result_envelopes ?? [];
    const actionDetail =
      derived.action === 'ADMIT_WORKER_RESULT' && pendingEnvelopes.length > 0
        ? `${derived.action_detail} (actionToken: ${pendingEnvelopes[0].actionToken})`
        : derived.action_detail;
    return {
      action: derived.action,
      action_detail: actionDetail,
      responsible_role: derived.responsible_role,
      receipt_chain_valid: derived.receipt_chain_valid,
      findings: [...derived.findings].slice(0, MAX_FINDINGS),
    };
  }
}

// ============================================================
// Extras construction — deterministic persisted facts (HP-003)
// ============================================================

/**
 * Build `NextActionExtras` from deterministic persisted facts:
 *
 * - `receipt_chain_valid` — carried straight from the reconcile output (the
 *   chain-validation step of the pipeline; false blocks every execution
 *   action in the derive table);
 * - `repartition_requested` — the manifest canonical field (F-S02-08);
 * - `evidence_file_present_by_slice` — work-tree evidence-file existence per
 *   manifest `evidence_path`;
 * - `gate_pass_present` / `gate_fail_present` — GATE_PASS / GATE_FAIL receipt
 *   existence in the stage-gate category, derived ONLY from a valid chain
 *   (PO-S02-C-03 fact blocking);
 * - `pending_worker_result_envelopes` — schema-validated, stage-bound result
 *   envelopes in the contract results dir (`.pi/proofloop-runtime/results/`).
 *
 * Absent facts never enable an action that requires positive knowledge
 * (HP-003 — never a guess).
 */
function buildExtras(
  reconciled: ReconcileStageResult,
  input: NextActionServiceInput,
): NextActionExtras {
  // Mutable accumulator — returned as the readonly NextActionExtras shape.
  const extras: {
    receipt_chain_valid: boolean;
    repartition_requested?: boolean;
    gate_pass_present?: boolean;
    gate_fail_present?: boolean;
    evidence_file_present_by_slice?: Record<string, boolean>;
    pending_worker_result_envelopes?: WorkerResultEnvelope[];
  } = {
    receipt_chain_valid: reconciled.receipt_chain_valid,
  };

  // Manifest canonical facts (repartition + evidence paths). The manifest
  // source is deterministic; when it is unavailable reconcile has already
  // reported the canonical Finding and the extras stay absent.
  try {
    const { manifest } = manifestSource({
      projectRoot: input.projectRoot,
      stageId: input.stageId,
      manifestPath: input.manifestPath,
    });
    if (manifest.repartition_requested === true) {
      extras.repartition_requested = true;
    }
    const present: Record<string, boolean> = {};
    for (const slice of manifest.slices) {
      present[slice.slice_id] = fs.existsSync(
        path.join(input.projectRoot, slice.evidence_path),
      );
    }
    extras.evidence_file_present_by_slice = present;
  } catch (err) {
    if (!(err instanceof ManifestSourceError)) throw err;
  }

  // Gate facts — only from a valid stage-gate chain. A broken gate chain
  // already forces VALIDATE through `receipt_chain_valid=false` (row 0);
  // deriving gate presence from a broken chain would violate fact blocking.
  const gate = readReceiptCategory({
    projectRoot: input.projectRoot,
    category: 'stage-gate',
    stageId: input.stageId,
  });
  if (gate.chainValid) {
    extras.gate_pass_present = gate.receipts.some((r) => r.receipt.type === 'GATE_PASS');
    extras.gate_fail_present = gate.receipts.some((r) => r.receipt.type === 'GATE_FAIL');
  }

  // Pending worker result envelopes. CV verdict envelopes share the
  // WorkerResultEnvelope mechanism, but their precise schema is S03 — S02
  // never claims an envelope as a CV envelope (never a guess).
  const pending = readPendingWorkerEnvelopes(input.projectRoot, input.stageId);
  if (pending.length > 0) {
    extras.pending_worker_result_envelopes = pending;
  }

  return extras;
}

/**
 * Deterministic read of the pending-results directory (contract §4).
 *
 * Filenames are sorted for determinism; only schema-valid envelopes bound to
 * the requested stage are returned. Unparseable / schema-invalid files fail
 * closed — they never become a claimable pending fact (HP-003).
 */
function readPendingWorkerEnvelopes(
  projectRoot: string,
  stageId: string,
): WorkerResultEnvelope[] {
  const dir = path.join(projectRoot, ...PENDING_RESULTS_REL);
  // Trust-root boundary (S2-F-003): a pending-results directory whose
  // canonical path escapes the project root is NEVER read. Pending results
  // are optional facts, but an escape is a trust violation — not an absence —
  // so this fails closed (structured Error) and the plugin stageNextHandler
  // error boundary maps it to a canonical Finding instead of deriving state
  // from outside files.
  if (canonicalPathWithinRoot(projectRoot, dir) === null) {
    throw new Error(
      `pending worker results directory escapes the project root trust boundary: ${dir}`,
    );
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const envelopes: WorkerResultEnvelope[] = [];
  for (const name of [...names].sort()) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    // Trust-root boundary (S2-F-003 round 3, atomic no-follow boundary): the
    // envelope is read through an O_NOFOLLOW fd against its canonical parent —
    // a symlink replacement between any pre-check and the read cannot redirect
    // the read outside the root. Escaping or unreadable files are skipped
    // (fail-closed): they never become a pending fact, so they can never drive
    // ADMIT_WORKER_RESULT.
    const opened = openNoFollowRead(projectRoot, filePath);
    if (!opened.ok) {
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(opened.fd, 'utf-8');
    } catch {
      continue;
    } finally {
      fs.closeSync(opened.fd);
    }
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    try {
      const envelope = validateWorkerResultEnvelope(data);
      if (envelope.stageId === stageId) envelopes.push(envelope);
    } catch {
      continue;
    }
  }
  return envelopes;
}
