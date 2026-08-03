/**
 * run-gate — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Stage Gate execution over the B1a Process Runner (blueprint §11), with
 * service lifecycle implemented (B1b) — parity with the legacy runtime's
 * `run-stage.ts` executeRuntimeProof (behavior authority):
 *
 *   node packages/runtime/dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]
 *
 * Flow:
 *  1. load + kernel-validate the manifest;
 *  2. load the Slice COMPLETE Facts (JSON array) — every manifest slice must
 *     carry a fact with `integrated: true`; facts for undeclared slices are
 *     refused (stale-fact guard);
 *  3. execute the manifest `runtime_proof` steps sequentially:
 *     - `command`/`probe` steps run through `runProcess` (bounded output,
 *       per-step timeout with process-tree cleanup) with the `expected`
 *       oracle — `expected.exit_code` absent → 0; `exit_code: null` → any
 *       exit accepted; timeout always FAILs;
 *     - `service_start` steps `spawnService` (cwd resolved under
 *       projectRoot), `registerService(step.id, handle)` and, when a
 *       `readiness_signal` is declared, `waitForReadiness(handle, signal,
 *       step.timeout_ms)` — ready → pass; early exit → FAIL (exit code
 *       recorded); timeout → FAIL. In BOTH failure cases the service is
 *       stopped (stopService) so it cannot leak;
 *     - `service_stop` steps look up the registry by `service_ref` (or
 *       step.id) and `stopService` the tree; an unknown ref FAILs the step;
 *     - `not_applicable` steps are skipped;
 *     - execution stops at the first failed step (legacy parity);
 *  4. mandatory cleanup at Gate end (PASS or FAIL): `cleanupServices()` stops
 *     every still-registered service; a service that was stopped by cleanup
 *     but has a DECLARED service_stop step counts as "explicit stop was
 *     missed" → Gate FAIL (legacy semantics); cleanup failures / remaining
 *     PIDs also FAIL the gate;
 *  5. write the gate result JSON to `<output-dir>/gate-result.json`
 *     (default `<projectRoot>/.proofloop/runtime/<stageId>/`).
 *
 * Output: JSON `{ success, gate, stage_id, steps, errors, output_path }`;
 * exit 0 on PASS / 1 on FAIL. The GATE_PASS/GATE_FAIL Receipt is written by
 * the unified admit pipeline (S03-H-T02 `admitGateResult`) — run-gate never
 * writes receipts itself.
 *
 * Behaviour differences vs. the legacy runtime's run-stage.ts (deliberate):
 *   - readiness timeout / early-exit FAILs now STOP the service immediately
 *     (the legacy runner left it running and relied on final cleanup);
 *   - command/probe steps use `runProcess` which ENFORCES the shell
 *     prohibition rules (legacy pre-validated every step up front with
 *     validateSpawnOptions; here a rejected step fails at execution with the
 *     SpawnValidationError message);
 *   - service steps are NOT shell-prohibited-validated (spawnService parity:
 *     the spawn failure path covers ENOENT etc.).
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateManifest } from '@proofloop/kernel';
import type { Manifest, RuntimeProofStep } from '@proofloop/kernel';
import {
  runProcess,
  spawnService,
  registerService,
  getRegisteredService,
  stopService,
  waitForReadiness,
  cleanupServices,
} from '../process-runner';
import type { ServiceCleanupResult } from '../process-runner';

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
// Step execution (service lifecycle B1b + command/probe via runProcess)
// ============================================================

function expectedExitCode(step: RuntimeProofStep): number | null {
  const expected = step.expected;
  if (expected === undefined) return 0;
  const value = expected['exit_code'];
  if (value === null || value === undefined) return null; // any exit accepted
  return typeof value === 'number' ? value : 0;
}

/**
 * Execute one runtime_proof step.
 *
 * - `not_applicable` → skipped (PASS, skipped: true);
 * - `service_start` → spawn + register + (readiness wait), stop on failure;
 * - `service_stop` → registry lookup by service_ref (or step id) + stop;
 * - `command` / `probe` → `runProcess` with the expected.exit_code oracle.
 */
async function executeStepAsync(
  step: RuntimeProofStep,
  projectRoot: string,
): Promise<GateStepResult> {
  // not_applicable steps are skipped by declaration.
  if (step.not_applicable !== undefined) {
    return { id: step.id, type: step.type, exit_code: null, passed: true, skipped: true };
  }

  const cwd = path.resolve(projectRoot, step.cwd ?? '.');

  if (step.type === 'service_start') {
    return executeServiceStart(step, cwd);
  }
  if (step.type === 'service_stop') {
    return executeServiceStop(step);
  }
  return executeCommandStep(step, cwd);
}

/**
 * service_start: spawnService → registerService(step.id) → waitForReadiness
 * (when declared). Readiness timeout / early exit FAIL the step AND stop the
 * service (no process leaks); spawn failure FAILs the step.
 */
async function executeServiceStart(
  step: RuntimeProofStep,
  cwd: string,
): Promise<GateStepResult> {
  const startTime = Date.now();
  try {
    const handle = await spawnService({
      executable: step.executable,
      args: step.args ?? [],
      cwd,
    });
    registerService(step.id, handle);

    let readinessMs = 0;
    if (step.readiness_signal) {
      const readyStart = Date.now();
      const readiness = await waitForReadiness(handle, step.readiness_signal, step.timeout_ms);
      readinessMs = Date.now() - readyStart;

      if (!readiness.ready) {
        // The service must not leak — stop it in BOTH failure cases
        // (hardening over the legacy runner, which left it running).
        try {
          await stopService(handle);
        } catch {
          // best-effort; the readiness failure below is the primary error
        }
        if (readiness.exited) {
          return {
            id: step.id,
            type: step.type,
            exit_code: readiness.exitCode,
            passed: false,
            error:
              `Step "${step.id}" (service_start) process exited (code ${readiness.exitCode}) ` +
              `before readiness signal "${step.readiness_signal}" was found. ` +
              `Stdout: ${handle.getStdout().slice(0, 500)}`,
          };
        }
        return {
          id: step.id,
          type: step.type,
          exit_code: null,
          passed: false,
          error:
            `Step "${step.id}" (service_start) readiness signal "${step.readiness_signal}" ` +
            `not found within ${step.timeout_ms}ms. ` +
            `Stdout: ${handle.getStdout().slice(0, 500)}`,
        };
      }
    }

    const observations = [
      `Service started, PID ${handle.pid}`,
      step.readiness_signal ? `Readiness signal found after ${readinessMs}ms` : '',
    ]
      .filter(Boolean)
      .join(' | ');
    return { id: step.id, type: step.type, exit_code: 0, passed: true, observations };
  } catch (err) {
    return {
      id: step.id,
      type: step.type,
      exit_code: null,
      passed: false,
      error:
        `Step "${step.id}" (service_start) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * service_stop: look up the registered service by `service_ref` (or step.id)
 * and stop it (tree kill). An unknown ref FAILs the step (legacy semantics).
 */
async function executeServiceStop(step: RuntimeProofStep): Promise<GateStepResult> {
  const ref = step.service_ref ?? step.id;
  const service = getRegisteredService(ref);
  if (service === undefined) {
    return {
      id: step.id,
      type: step.type,
      exit_code: null,
      passed: false,
      error:
        `Step "${step.id}" (service_stop): no registered service found for ref "${ref}". ` +
        `Ensure the corresponding service_start step ran successfully.`,
    };
  }
  try {
    const stopped = await stopService(ref);
    if (!stopped) {
      return {
        id: step.id,
        type: step.type,
        exit_code: null,
        passed: false,
        error:
          `Step "${step.id}" (service_stop): registered service "${ref}" not found or already stopped`,
      };
    }
    return {
      id: step.id,
      type: step.type,
      exit_code: 0,
      passed: true,
      observations: `Service stopped (PID ${service.pid})`,
    };
  } catch (err) {
    return {
      id: step.id,
      type: step.type,
      exit_code: null,
      passed: false,
      error:
        `Step "${step.id}" (service_stop) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * command / probe: one-shot runProcess (bounded output, per-step timeout with
 * process-tree cleanup, shell-prohibition enforcement) + expected.exit_code
 * oracle (`null` = any exit accepted; absent = 0; timeout always FAILs).
 */
async function executeCommandStep(
  step: RuntimeProofStep,
  cwd: string,
): Promise<GateStepResult> {
  const expected = expectedExitCode(step);
  try {
    const result = await runProcess({
      executable: step.executable,
      args: step.args ?? [],
      cwd,
      timeoutMs: step.timeout_ms,
    });

    const observations = [
      result.stdout.length > 0 ? `stdout: ${result.stdout.slice(0, 1000)}` : '',
      result.stderr.length > 0 ? `stderr: ${result.stderr.slice(0, 1000)}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 2000) || undefined;

    if (result.timedOut) {
      return {
        id: step.id,
        type: step.type,
        exit_code: null,
        passed: false,
        error:
          `step "${step.id}" timed out after ${step.timeout_ms}ms` +
          (result.stderr ? ` — stderr: ${result.stderr.slice(0, 500)}` : ''),
      };
    }

    const passed = expected === null || result.exitCode === expected;
    if (!passed) {
      return {
        id: step.id,
        type: step.type,
        exit_code: result.exitCode,
        passed: false,
        error:
          `step "${step.id}" exited ${result.exitCode}, ` +
          `expected ${expected === null ? 'any' : expected}` +
          (result.stderr ? ` — stderr: ${result.stderr.slice(0, 500)}` : ''),
      };
    }
    return { id: step.id, type: step.type, exit_code: result.exitCode, passed: true, observations };
  } catch (err) {
    // SpawnValidationError (shell prohibition) or unexpected runner failure.
    return {
      id: step.id,
      type: step.type,
      exit_code: null,
      passed: false,
      error: `step "${step.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Mandatory Gate-end cleanup (PASS or FAIL): stop every still-registered
 * service. A service that was stopped by cleanup but has a DECLARED
 * service_stop step means the explicit stop was missed → Gate FAIL (legacy
 * run-stage.ts semantics); cleanup failures / remaining PIDs also FAIL.
 */
async function finalizeCleanup(
  steps: readonly RuntimeProofStep[],
  errors: string[],
): Promise<void> {
  // Services with a declared service_stop step in the manifest.
  const serviceStopRefs = new Set(
    steps
      .filter((s) => s.type === 'service_stop')
      .map((s) => s.service_ref ?? s.id),
  );

  const serviceCleanup: ServiceCleanupResult = await cleanupServices();

  // Cleanup stopped a service that had an explicit service_stop declared —
  // the explicit stop was missed. This is a Gate FAIL.
  const missedExplicitStops = serviceCleanup.cleaned.filter((name) => serviceStopRefs.has(name));
  for (const name of missedExplicitStops) {
    errors.push(
      `Service "${name}" was still running at final cleanup but has a declared ` +
      `service_stop step. The explicit stop was missed. This is a Gate FAIL.`,
    );
  }

  if (serviceCleanup.failed.length > 0) {
    errors.push(
      `Service cleanup failures: ${serviceCleanup.failed
        .map((f) => `${f.service} (PID ${f.pid}): ${f.reason}`)
        .join('; ')}`,
    );
  }
  if (serviceCleanup.remainingPids.length > 0) {
    errors.push(
      `Services still running after cleanup: PIDs ${serviceCleanup.remainingPids.join(', ')}. ` +
      `Cleanup failure counts as Gate FAIL.`,
    );
  }
}

// ============================================================
// runGate
// ============================================================

/**
 * Run the Stage Gate over a manifest + Slice COMPLETE facts, executing the
 * manifest runtime_proof steps sequentially (service lifecycle + command /
 * probe with per-step timeout and exit-code checks) and enforcing mandatory
 * service cleanup at the end. Async because service readiness waits and
 * cleanup are asynchronous.
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
  const facts = validateFacts(manifest, factsRaw, errors);

  const steps: GateStepResult[] = [];
  if (facts !== null) {
    for (const step of manifest.runtime_proof ?? []) {
      const result = await executeStepAsync(step, projectRoot);
      steps.push(result);
      // Legacy parity: execution stops at the first failed step (a later
      // service_stop then counts as a missed explicit stop at cleanup).
      if (!result.passed && !result.skipped) {
        break;
      }
    }
    for (const step of steps) {
      if (!step.passed && step.error !== undefined) {
        errors.push(step.error);
      }
    }
    // Mandatory cleanup at Gate end — runs on PASS and FAIL alike.
    await finalizeCleanup(manifest.runtime_proof ?? [], errors);
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
export async function runGateCli(argv: readonly string[]): Promise<number> {
  const [manifestPath, factsPath, outputDir, projectRoot] = argv;
  if (!manifestPath || !factsPath) {
    console.error('Usage: node dist/cli/run-gate.js <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]');
    console.error('');
    console.error('Executes the Stage Gate (runtime_proof steps incl. service');
    console.error('lifecycle, per-step timeout + exit-code checks) and writes');
    console.error('gate-result.json.');
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
