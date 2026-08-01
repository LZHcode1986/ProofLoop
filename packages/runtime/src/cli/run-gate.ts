/**
 * run-gate — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Stage Gate execution, minimal version (HP-004: per-step timeout +
 * exit-code checks; no cancellation / process-tree cleanup /
 * GATE_INTERRUPTED — those are S04/AWI-015). Legacy-compatible contract:
 *
 *   node packages/runtime/dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 *
 * Flow:
 *  1. load + kernel-validate the manifest;
 *  2. load the Slice COMPLETE Facts (JSON array) — every manifest slice must
 *     carry a fact with `integrated: true`; facts for undeclared slices are
 *     refused (stale-fact guard);
 *  3. execute the manifest `runtime_proof` steps: `command`/`probe` steps run
 *     synchronously with per-step timeout and `expected.exit_code` check
 *     (absent expected → 0; `exit_code: null` → any exit accepted);
 *     `not_applicable` steps are skipped; `service_start`/`service_stop`
 *     steps that are NOT marked not_applicable fail the gate (service
 *     lifecycle execution is deferred to S04 — honest fail-closed);
 *  4. write the gate result JSON to `<output-dir>/gate-result.json`
 *     (default `<projectRoot>/.proofloop/runtime/<stageId>/`).
 *
 * Output: JSON `{ success, gate, stage_id, steps, errors, output_path }`;
 * exit 0 on PASS / 1 on FAIL. The GATE_PASS/GATE_FAIL Receipt is written by
 * the unified admit pipeline (S03-H-T02 `admitGateResult`) — run-gate never
 * writes receipts itself.
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateManifest } from '@proofloop/kernel';
import type { Manifest, RuntimeProofStep } from '@proofloop/kernel';

// ============================================================
// Shapes
// ============================================================

export interface RunGateInput {
  readonly manifestPath: string;
  readonly factsPath: string;
  readonly outputDir?: string;
  readonly projectRoot?: string;
}

export interface GateStepResult {
  readonly id: string;
  readonly type: string;
  readonly exit_code: number | null;
  readonly passed: boolean;
  readonly skipped?: boolean;
  readonly error?: string;
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
// Step execution (minimal — HP-004)
// ============================================================

function expectedExitCode(step: RuntimeProofStep): number | null {
  const expected = step.expected;
  if (expected === undefined) return 0;
  const value = expected['exit_code'];
  if (value === null || value === undefined) return null; // any exit accepted
  return typeof value === 'number' ? value : 0;
}

function executeStep(
  step: RuntimeProofStep,
  projectRoot: string,
): GateStepResult {
  // not_applicable steps are skipped by declaration.
  if (step.not_applicable !== undefined) {
    return { id: step.id, type: step.type, exit_code: null, passed: true, skipped: true };
  }
  // Service lifecycle steps without not_applicable are deferred to S04
  // (HP-004) — fail the gate honestly instead of silently skipping.
  if (step.type === 'service_start' || step.type === 'service_stop') {
    return {
      id: step.id,
      type: step.type,
      exit_code: null,
      passed: false,
      error:
        `service lifecycle step "${step.id}" is not marked not_applicable — ` +
        `service lifecycle execution is deferred to S04 (HP-004)`,
    };
  }
  const cwd = path.resolve(projectRoot, step.cwd ?? '.');
  const expected = expectedExitCode(step);
  try {
    execFileSync(step.executable, step.args ?? [], {
      cwd,
      timeout: step.timeout_ms,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const passed = expected === null || expected === 0;
    return { id: step.id, type: step.type, exit_code: 0, passed };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.code === 'ETIMEDOUT') {
      return {
        id: step.id,
        type: step.type,
        exit_code: null,
        passed: false,
        error: `step "${step.id}" timed out after ${step.timeout_ms}ms`,
      };
    }
    const actual = e.status ?? 1;
    const passed = expected === null || actual === expected;
    return {
      id: step.id,
      type: step.type,
      exit_code: actual,
      passed,
      error: passed
        ? undefined
        : `step "${step.id}" exited ${actual}, expected ${expected === null ? 'any' : expected}`,
    };
  }
}

// ============================================================
// runGate
// ============================================================

/**
 * Run the Stage Gate (minimal version) over a manifest + Slice COMPLETE
 * facts, executing the manifest runtime_proof steps with per-step timeout
 * and exit-code checks.
 */
export function runGate(input: RunGateInput): RunGateResult {
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
  const facts = validateFacts(manifest, factsRaw, errors);

  const steps: GateStepResult[] = [];
  if (facts !== null) {
    for (const step of manifest.runtime_proof ?? []) {
      steps.push(executeStep(step, projectRoot));
    }
    for (const step of steps) {
      if (!step.passed && step.error !== undefined) {
        errors.push(step.error);
      }
    }
  }

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
// CLI entry
// ============================================================

/**
 * Legacy-compatible CLI:
 *   node dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 */
export function runGateCli(argv: readonly string[]): number {
  const [manifestPath, factsPath, outputDir, projectRoot] = argv;
  if (!manifestPath || !factsPath) {
    console.error('Usage: node dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]');
    console.error('');
    console.error('Executes the Stage Gate (runtime_proof steps with per-step');
    console.error('timeout + exit-code checks) and writes gate-result.json.');
    console.error('Outputs the gate result JSON to stdout; exit 0 on PASS, 1 on FAIL.');
    return 1;
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest file not found: ${manifestPath}`);
    return 1;
  }
  if (!fs.existsSync(factsPath)) {
    console.error(`Slice COMPLETE facts file not found: ${factsPath}`);
    return 1;
  }
  const result = runGate({
    manifestPath,
    factsPath,
    outputDir: outputDir || undefined,
    projectRoot: projectRoot || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = runGateCli(process.argv.slice(2));
}
