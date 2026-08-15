/**
 * run-gate — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Stage Gate over the v1/vNext Manifest routes:
 *
 *   node packages/runtime/dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 *
 * Flow (v1 route):
 *  1. load + kernel-validate the manifest;
 *  2. load the Slice COMPLETE Facts (JSON array) — every manifest slice must
 *     carry a fact with `integrated: true`; facts for undeclared slices are
 *     refused (stale-fact guard);
 *  3. the Gate NEVER executes Manifest `runtime_proof` steps (the transition
 *     check was deleted by the 2026-08-13 ruling; build/test is the Stage
 *     Review's job) — the verdict comes from the facts validation alone;
 *  4. write the gate result JSON to `<output-dir>/gate-result.json`
 *     (default `<projectRoot>/.proofloop/runtime/<stageId>/`).
 *
 * Output: JSON `{ success, gate, stage_id, steps, errors, output_path }`;
 * exit 0 on PASS / 1 on FAIL. The GATE_PASS/GATE_FAIL Receipt is written by
 * the unified admit pipeline (S03-H-T02 `admitGateResult`) — run-gate never
 * writes receipts itself.
 *
 * vNext route (`runGateVNext`, dual-path SG): the Manifest runtime_proof
 * commands are NEVER executed and no runtime_proof_digest is bound (the
 * field was deleted).  The Gate verifies integration completeness through
 * the admission consumer — per-Slice INTEGRATION_PASS Receipt chains
 * (default `receipts`) or the explicit `git_facts` fallback.
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, validateManifest } from '@proofloop/kernel';
import type { Manifest, VNextManifest } from '@proofloop/kernel';
import * as git from '../git-source';
import { detectPlanManifestRoute } from '../plan-services';
import { readVNextManifest } from '../vnext/dispatch';
import { canonicalPathWithinRoot } from '../path-guard';
import { admitVNextGateResult } from '../vnext/gate-admission';
// S09-REVIEW-001: the CLI entry applies the shared canonical Stage ID guard
// BEFORE reading the Manifest — a parked legacy label such as S08B0/S08B in
// the manifest path fails closed before any Runtime read/execute/write.
import { assertCanonicalStageId } from '../vnext/stage-id';
// P-11 task B: read-only STAGE_CLOSE archived-facts probe.  `runGateVNext` on
// an archived Stage is refused with zero writes (the Stage is a historical
// snapshot and is never re-gated).
import { readStageCloseFacts } from '../vnext/stage-close-facts';

// ============================================================
// Shapes
// ============================================================

export interface RunGateInput {
  readonly manifestPath: string;
  readonly factsPath: string;
  readonly outputDir?: string;
  readonly projectRoot?: string;
  /**
   * Dual-path SG (vNext route only): explicit Gate verification path —
   * `receipts` (default, per-Slice INTEGRATION_PASS Receipt chains) or the
   * explicit `git_facts` fallback (Git-history facts).  The v1 route ignores
   * it.  The admission seam fails closed without the explicit declaration.
   */
  readonly verificationSource?: 'receipts' | 'git_facts';
  /**
   * P-09 (vNext route only): explicit REPAIR-driven re-run declaration —
   * when `true` and the stage-gate chain already has a PASS tip, the Gate is
   * allowed to append a NEW GATE Receipt (the old PASS stays as write-once
   * history) provided the stage review chain tip is a REPAIR verdict
   * (enforced by gate admission).  The v1 route ignores it.
   */
  readonly reGate?: boolean;
}

export interface GateStepResult {
  readonly id: string;
  readonly type: string;
  readonly exit_code: number | null;
  readonly passed: boolean;
  readonly skipped?: boolean;
  readonly error?: string;
  /** Human-readable observations (stdout/stderr snippets, service PIDs). */
  readonly observations?: string;
}

export interface RunGateResult {
  readonly success: boolean;
  readonly gate: 'PASS' | 'FAIL';
  readonly stage_id: string;
  readonly steps: readonly GateStepResult[];
  readonly errors: readonly string[];
  readonly output_path?: string;
}

// ============================================================
// Facts validation
// ============================================================

interface GateFact {
  readonly slice_id: string;
  readonly integrated?: unknown;
}

/**
 * Validate the Slice COMPLETE Facts file: a JSON array; every manifest slice
 * present with `integrated: true`; no facts for undeclared slices.
 */
function validateFacts(
  manifest: Manifest,
  raw: unknown,
  errors: string[],
): GateFact[] | null {
  if (!Array.isArray(raw)) {
    errors.push('Slice COMPLETE facts file must contain a JSON array.');
    return null;
  }
  const facts = raw as unknown[];
  const byId = new Map<string, GateFact>();
  for (const entry of facts) {
    if (typeof entry !== 'object' || entry === null) {
      errors.push('Slice COMPLETE facts entries must be JSON objects.');
      return null;
    }
    const fact = entry as Record<string, unknown>;
    const sliceId = fact['slice_id'];
    if (typeof sliceId !== 'string' || sliceId.length === 0) {
      errors.push('Slice COMPLETE facts entries must carry a non-empty slice_id.');
      return null;
    }
    byId.set(sliceId, fact as unknown as GateFact);
  }
  for (const slice of manifest.slices) {
    const fact = byId.get(slice.slice_id);
    if (fact === undefined) {
      errors.push(`Slice "${slice.slice_id}" has no COMPLETE fact entry — gate refused`);
    } else if (fact.integrated !== true) {
      errors.push(`Slice "${slice.slice_id}" COMPLETE fact is not integrated: true — gate refused`);
    }
  }
  for (const sliceId of byId.keys()) {
    if (!manifest.slices.some((s) => s.slice_id === sliceId)) {
      errors.push(`COMPLETE fact for undeclared slice "${sliceId}" — stale facts refused`);
    }
  }
  return byId.size > 0 && errors.length === 0 ? facts as unknown as GateFact[] : null;
}

// ============================================================
// runGate
// ============================================================

/**
 * Run the Stage Gate over a v1 manifest + Slice COMPLETE facts.
 *
 * The Gate never executes Manifest runtime_proof steps (transition check
 * deleted): the verdict is decided by the Slice COMPLETE facts validation
 * alone (build/test is the Stage Review's job).
 */
export async function runGate(input: RunGateInput): Promise<RunGateResult> {
  const projectRoot = path.resolve(input.projectRoot ?? '.');
  const errors: string[] = [];

  let manifest: Manifest;
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(input.manifestPath, 'utf-8')));
  } catch (err) {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: 'unknown',
      steps: [],
      errors: [`cannot load/validate manifest "${input.manifestPath}": ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  let factsRaw: unknown;
  try {
    factsRaw = JSON.parse(fs.readFileSync(input.factsPath, 'utf-8'));
  } catch (err) {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: manifest.stage_id,
      steps: [],
      errors: [`cannot read facts file "${input.factsPath}": ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  validateFacts(manifest, factsRaw, errors);

  // No runtime_proof step execution: the v1 Gate verdict is decided entirely
  // by the Slice COMPLETE facts (the transition-check commands were deleted).
  const steps: GateStepResult[] = [];
  const gate: 'PASS' | 'FAIL' = errors.length === 0 ? 'PASS' : 'FAIL';

  // Result file (best-effort — a write failure is surfaced, not silent).
  const outputDir = path.resolve(
    input.outputDir ?? path.join(projectRoot, '.proofloop', 'runtime', manifest.stage_id),
  );
  const outputPath = path.join(outputDir, 'gate-result.json');
  let writtenPath: string | undefined;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const partial: Record<string, unknown> = {
      success: gate === 'PASS',
      gate,
      stage_id: manifest.stage_id,
      steps,
      errors,
      output_path: outputPath,
    };
    fs.writeFileSync(outputPath, JSON.stringify(partial, null, 2), 'utf-8');
    writtenPath = outputPath;
  } catch (err) {
    errors.push(`cannot write gate result to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    success: gate === 'PASS' && writtenPath !== undefined,
    gate: errors.length === 0 && writtenPath !== undefined ? 'PASS' : 'FAIL',
    stage_id: manifest.stage_id,
    steps,
    errors,
    output_path: writtenPath,
  };
}

// ============================================================
// runGateVNext — vNext Stage Gate (S08-E-T06 vNext Gate consumer CLI route)
// ============================================================

/**
 * S09-REVIEW-001: infer the Stage label from the manifest path and apply the
 * shared canonical Stage ID guard at the EARLIEST entry point (before the
 * Manifest is read, executed or written).  A path whose basename starts with
 * an `S` label that is not canonical (`S08B0`/`S08B` and friends) fails
 * closed; non-stage filenames (e.g. `manifest.json`) are left to the
 * Manifest-declared stage_id validation that follows.
 */
function assertCanonicalStageLabelFromManifestPath(manifestPath: string): void {
  const label = path.basename(manifestPath, path.extname(manifestPath));
  if (label.length > 0 && label.startsWith('S')) {
    assertCanonicalStageId(label, 'manifest path stage label');
  }
}

function readProjectHead(projectRoot: string): string | null {
  try {
    const gitRoot = git.resolveGitRoot(projectRoot);
    return git.readGitHead(gitRoot);
  } catch {
    return null;
  }
}

/**
 * Run the Stage Gate over a vNext Manifest (dual-path SG, decision
 * 2026-08-13).  The Gate context is authoritative on the persisted facts: all
 * integration readiness plus the clean-tree / HEAD-snapshot binding are
 * verified inside `admitVNextGateResult`.  The Manifest runtime_proof
 * commands are NEVER executed and no runtime_proof_digest is bound (the
 * field was deleted), then the single GATE_PASS/GATE_FAIL Receipt is
 * delegated to the vNext Gate consumer.
 *
 * `input.verificationSource` selects the Gate verification path: `receipts`
 * (default — per-Slice INTEGRATION_PASS Receipt chains) or the explicit
 * `git_facts` fallback (Git-history facts; the admission seam fails closed
 * without the explicit declaration).
 *
 * `input.reGate` (P-09): explicit REPAIR-driven re-run — when `true` and the
 * stage-gate chain already has a PASS tip, a NEW GATE Receipt is appended
 * (the old PASS stays as write-once history) provided the stage review chain
 * tip is a REPAIR verdict (enforced by gate admission).
 *
 * The Slice COMPLETE facts file is a v1-only input in the vNext route; when
 * present it is deliberately ignored (the vNext Gate reads the persisted
 * Integration Receipts / Git facts instead).  No v1 manifest/reconcile/legacy
 * consumer is ever entered.
 */
export async function runGateVNext(input: RunGateInput): Promise<RunGateResult> {
  const projectRoot = path.resolve(input.projectRoot ?? '.');
  const manifestPath = path.resolve(input.manifestPath);
  const errors: string[] = [];

  // S09-REVIEW-001: fail closed BEFORE any Manifest read — the parked legacy
  // labels can never reach the route probe or admission.
  try {
    assertCanonicalStageLabelFromManifestPath(manifestPath);
  } catch (err) {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: 'unknown',
      steps: [],
      errors: [
        `run-gate (vNext) refused before reading the Manifest: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const route = detectPlanManifestRoute(projectRoot, manifestPath);
  if (route !== 'vnext') {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: 'unknown',
      steps: [],
      errors: [`run-gate (vNext) refused: Manifest route is "${route}", expected "vnext"`],
    };
  }

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(projectRoot, manifestPath);
  } catch (err) {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: 'unknown',
      steps: [],
      errors: [
        `run-gate (vNext) cannot load the vNext Manifest "${input.manifestPath}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  const stageId = manifest.stage_id;

  // S09-REVIEW-002-F01: the Manifest-DECLARED stage_id is guarded BEFORE any
  // gate-result write.  The filename-label guard above cannot see a
  // manifest.json whose declared stage_id is a parked legacy label
  // (S08B0/S08B) — the declared value itself fails closed here.
  try {
    assertCanonicalStageId(stageId, 'manifest.stage_id');
  } catch (err) {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: stageId,
      steps: [],
      errors: [
        `run-gate (vNext) refused before admission: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  // P-11 task B: archived-Stage guard（拒绝路径零副作用）。存在合法 v2
  // STAGE_CLOSE_RESULT envelope ⇒ Stage 已归档（历史快照）：拒绝执行，不跑
  // proof、不写 Receipt、不写 gate-result.json。探测 root-bound 且
  // fail-closed —— 目录不可读同样 FAIL（绝不降级为“未归档”）。
  let closeFacts: ReturnType<typeof readStageCloseFacts>;
  try {
    closeFacts = readStageCloseFacts(projectRoot, stageId);
  } catch (err) {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: stageId,
      steps: [],
      errors: [
        `run-gate (vNext) refused: stage-close facts are unavailable (nothing executed, nothing written): ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  if (closeFacts.archived) {
    const closeType = closeFacts.close_type !== undefined ? `, close_type=${closeFacts.close_type}` : '';
    const digest = closeFacts.receipt_digest !== undefined ? ` (receipt ${closeFacts.receipt_digest})` : '';
    return {
      success: false,
      gate: 'FAIL',
      stage_id: stageId,
      steps: [],
      errors: [
        `run-gate (vNext) refused: stage "${stageId}" is archived (STAGE_CLOSE${closeType}${digest}); archived stages are historical snapshots and are never re-gated (nothing executed, nothing written)`,
      ],
    };
  }

  const snapshotDigest = readProjectHead(projectRoot);
  if (snapshotDigest === null) {
    errors.push('run-gate (vNext): cannot resolve the current Git HEAD as the integrated snapshot');
  }

  let manifestDigest: string;
  try {
    manifestDigest = computeDigest(manifest);
  } catch (err) {
    return {
      success: false,
      gate: 'FAIL',
      stage_id: stageId,
      steps: [],
      errors: [`run-gate (vNext) cannot digest the Manifest: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // No runtime_proof execution or digest binding: the Gate verdict is decided
  // entirely by the admission consumer (integration completeness — Receipts
  // or explicit Git-facts fallback).  A refused admission is an honest FAIL
  // with zero Receipt writes (no forged PASS).
  const steps: GateStepResult[] = [];
  const admission = admitVNextGateResult({
    type: 'gate_result',
    stageId,
    verdict: 'PASS',
    manifestDigest,
    snapshotDigest: snapshotDigest ?? '',
    summary: `run-gate vNext: slice integration proof(s) verified via ${input.verificationSource ?? 'receipts'}`,
    ...(input.verificationSource === undefined ? {} : { verification_source: input.verificationSource }),
    // P-09: REPAIR-driven re-run — the explicit re-gate declaration passes
    // through to gate admission (which enforces the REPAIR review tip).
    ...(input.reGate === true ? { re_gate: true } : {}),
  }, { projectRoot });

  if (!admission.accepted) {
    for (const finding of admission.findings) errors.push(finding.message);
  }
  const gate: 'PASS' | 'FAIL' = admission.accepted ? 'PASS' : 'FAIL';

  const outputDir = path.resolve(
    input.outputDir ?? path.join(projectRoot, '.proofloop', 'runtime', stageId),
  );
  const outputPath = path.join(outputDir, 'gate-result.json');
  let writtenPath: string | undefined;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const partial: Record<string, unknown> = {
      success: gate === 'PASS' && admission.accepted,
      gate,
      stage_id: stageId,
      steps,
      errors,
      // ~vNext Gate admission binding
      vnext: {
        manifest_digest: manifestDigest,
        snapshot_digest: snapshotDigest,
        verification_source: input.verificationSource ?? 'receipts',
        receipt_ref: admission.receipt_ref,
      },
      output_path: outputPath,
    };
    fs.writeFileSync(outputPath, JSON.stringify(partial, null, 2), 'utf-8');
    writtenPath = outputPath;
  } catch (err) {
    errors.push(`cannot write gate result to "${outputPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    success: gate === 'PASS' && admission.accepted && writtenPath !== undefined,
    gate: gate === 'PASS' && admission.accepted && writtenPath !== undefined ? 'PASS' : 'FAIL',
    stage_id: stageId,
    steps,
    errors,
    output_path: writtenPath,
  };
}
// ============================================================
// CLI entry
// ============================================================

/**
 * CLI entry with explicit v1/vNext route selection:
 *   node dist/cli/run-gate.js <manifest-path> [slice-complete-facts-path] [output-dir] [project-root]
 *
 * A vNext Manifest (detected via the canonical route probe) runs through
 * `runGateVNext` and never enters the legacy v1 flow; the facts file is then
 * optional (the vNext Gate reads persisted Integration Receipts).  Unknown
 * routes are refused, never silently degraded to the v1 path.
 */
export async function runGateCli(argv: readonly string[]): Promise<number> {
  // Dual-path SG: optional `--verification-source <receipts|git_facts>` flag
  // (vNext route); unknown values fail closed before anything runs.
  // P-09: optional `--re-gate` boolean flag (REPAIR-driven re-run).
  const positionals: string[] = [];
  let verificationSource: 'receipts' | 'git_facts' | undefined;
  let reGate: boolean | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--verification-source') {
      const value = argv[index + 1];
      if (value !== 'receipts' && value !== 'git_facts') {
        console.error('run-gate: --verification-source must be "receipts" or "git_facts"');
        return 1;
      }
      verificationSource = value;
      index += 1;
      continue;
    }
    if (token === '--re-gate') {
      reGate = true;
      continue;
    }
    positionals.push(token);
  }
  const [manifestPath, factsPath, outputDir, projectRoot] = positionals;
  if (!manifestPath) {
    console.error('Usage: node dist/cli/run-gate.js <manifest-path> [slice-complete-facts-path] [output-dir] [project-root]');
    console.error('');
    console.error('Runs the Stage Gate (integration completeness check;');
    console.error('never executes runtime_proof commands) and writes');
    console.error('gate-result.json.');
    console.error('Outputs the gate result JSON to stdout; exit 0 on PASS, 1 on FAIL.');
    return 1;
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest file not found: ${manifestPath}`);
    return 1;
  }

  const resolvedRoot = path.resolve(projectRoot ?? '.');
  const resolvedManifest = path.resolve(manifestPath);
  // S09-REVIEW-001: canonical Stage ID guard at the earliest CLI point —
  // before the Manifest is read, the route is probed or any step runs.
  try {
    assertCanonicalStageLabelFromManifestPath(resolvedManifest);
  } catch (err) {
    console.error(
      `run-gate refused before reading the Manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  const route = detectPlanManifestRoute(resolvedRoot, resolvedManifest);
  if (route === 'unknown') {
    console.error(
      `Manifest route is unknown for "${manifestPath}"; run-gate never falls back to the legacy v1 path`,
    );
    return 1;
  }
  if (route === 'vnext') {
    const result = await runGateVNext({
      manifestPath: resolvedManifest,
      factsPath: factsPath ?? '',
      outputDir: outputDir || undefined,
      projectRoot: resolvedRoot,
      verificationSource,
      reGate,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.success ? 0 : 1;
  }

  if (!factsPath) {
    console.error('Usage: node dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]');
    console.error('');
    console.error('A v1 Manifest requires the Slice COMPLETE facts file.');
    return 1;
  }
  if (!fs.existsSync(factsPath)) {
    console.error(`Slice COMPLETE facts file not found: ${factsPath}`);
    return 1;
  }
  const result = await runGate({
    manifestPath,
    factsPath,
    outputDir: outputDir || undefined,
    projectRoot: projectRoot || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  runGateCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
