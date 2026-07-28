import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Manifest as ManifestSchema, ProjectAcceptanceManifestSchema } from './schemas.js';
import type { Manifest, RuntimeProofStep, StepType, ProjectAcceptanceManifest, ProjectE2EReceipt } from './schemas.js';
import { validateRuntimeProofTopology } from './validate-topology.js';
import {
  runProcess,
  spawnService,
  registerService,
  getRegisteredService,
  stopRegisteredService,
  waitForReadiness,
  cleanupServices,
  cleanupProcesses,
  checkPortsFree,
  validateSpawnOptions,
} from './process-manager.js';
import type { ServiceCleanupResult } from './process-manager.js';
import { writeReceipt, writeProjectE2EReceipt, computeSnapshot, type StepResult } from './receipt-writer.js';
import { getPlatformInfo } from './platform-adapter.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunStageOptions {
  manifestPath: string;
  outputDir?: string;
  knownPids?: number[];
  knownPorts?: number[];
}

export interface RunStageResult {
  success: boolean;
  receiptPath?: string;
  errors: string[];
  stepCount: number;
}

// ── Shared Execution Engine ────────────────────────────────────────────────────

export interface ExecuteRuntimeProofOptions {
  knownPids?: number[];
  knownPorts?: number[];
}

export interface ExecuteRuntimeProofResult {
  success: boolean;
  stepResults: StepResult[];
  serviceCleanup: ServiceCleanupResult;
  errors: string[];
}

/**
 * Execute a sequence of RuntimeProofSteps in order.
 *
 * Flow:
 * 1. Validate all RuntimeProofStep definitions (no shells, no operators)
 * 2. Execute each step in sequence
 * 3. On first failure, stop
 * 4. Cleanup services and known PIDs / ports
 *
 * This is the shared execution core used by both Stage Gate and Project E2E runners.
 */
export async function executeRuntimeProof(
  steps: RuntimeProofStep[],
  options?: ExecuteRuntimeProofOptions,
): Promise<ExecuteRuntimeProofResult> {
  const knownPids = options?.knownPids ?? [];
  const knownPorts = options?.knownPorts ?? [];
  const errors: string[] = [];
  const stepResults: StepResult[] = [];
  let finalExitCode = 0;

  // ── 1. Validate steps ──
  for (const step of steps) {
    const validation = validateSpawnOptions({
      executable: step.executable,
      args: step.args,
      cwd: step.cwd,
      timeoutMs: step.timeout_ms,
    });

    if (!validation.valid) {
      for (const err of validation.errors) {
        errors.push(`Step "${step.id}" validation: ${err}`);
      }
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      stepResults,
      serviceCleanup: { cleaned: [], failed: [], remainingPids: [] },
      errors,
    };
  }

  // ── 2. Execute each step sequentially ──
  let executedCount = 0;
  let skippedCount = 0;

  for (const step of steps) {
    // Skip steps marked as not_applicable
    if (step.not_applicable?.reason) {
      stepResults.push({
        id: step.id,
        executable: step.executable,
        args: step.args,
        exit_code: 0,
        signal: null,
        timed_out: false,
        duration_ms: 0,
        observations: `Skipped: ${step.not_applicable.reason}`,
        skipped: true,
      });
      skippedCount++;
      continue;
    }
    executedCount++;

    const stepType: StepType = step.type ?? 'command';

    if (stepType === 'service_start') {
      // ── service_start: spawn, register, wait for readiness ──
      const startTime = Date.now();

      try {
        const handle = await spawnService({
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          timeoutMs: step.timeout_ms,
        });

        registerService(step.id, handle);

        let readinessWaitMs = 0;

        if (step.readiness_signal) {
          const readinessTimeout = step.timeout_ms;
          const readyStart = Date.now();
          const readiness = await waitForReadiness(handle, step.readiness_signal, readinessTimeout);
          readinessWaitMs = Date.now() - readyStart;

          if (!readiness.ready) {
            if (readiness.exited) {
              errors.push(
                `Step "${step.id}" (service_start) process exited (code ${readiness.exitCode}) before readiness signal "${step.readiness_signal}" was found. ` +
                `Stdout: ${handle.getStdout().slice(0, 500)}`,
              );
            } else {
              errors.push(
                `Step "${step.id}" (service_start) readiness signal "${step.readiness_signal}" not found within ${step.timeout_ms}ms. ` +
                `Stdout: ${handle.getStdout().slice(0, 500)}`,
              );
            }
            finalExitCode = finalExitCode || 2;
            break;
          }
        }

        const durationMs = Date.now() - startTime;
        const observations = [
          `Service started, PID ${handle.pid}`,
          step.readiness_signal ? `Readiness signal found after ${readinessWaitMs}ms` : '',
        ]
          .filter(Boolean)
          .join(' | ');

        stepResults.push({
          id: step.id,
          executable: step.executable,
          args: step.args,
          exit_code: 0,
          signal: null,
          timed_out: false,
          duration_ms: durationMs,
          observations,
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        errors.push(
          `Step "${step.id}" (service_start) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        finalExitCode = finalExitCode || 1;
        stepResults.push({
          id: step.id,
          executable: step.executable,
          args: step.args,
          exit_code: -1,
          signal: null,
          timed_out: false,
          duration_ms: durationMs,
          observations: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
    } else if (stepType === 'service_stop') {
      // ── service_stop: look up registered service by service_ref (or step.id) and terminate ──
      const startTime = Date.now();
      const ref = step.service_ref || step.id;
      const service = getRegisteredService(ref);

      if (!service) {
        errors.push(
          `Step "${step.id}" (service_stop): no registered service found for ref "${ref}". ` +
          `Ensure the corresponding service_start step ran successfully.`,
        );
        finalExitCode = finalExitCode || 1;
        stepResults.push({
          id: step.id,
          executable: step.executable,
          args: step.args,
          exit_code: -1,
          signal: null,
          timed_out: false,
          duration_ms: Date.now() - startTime,
          observations: `Error: no registered service "${ref}"`,
        });
        break;
      }

      try {
        const stopped = await stopRegisteredService(ref);
        if (!stopped) {
          throw new Error(`service_stop: registered service "${ref}" not found or already stopped`);
        }
        const durationMs = Date.now() - startTime;

        stepResults.push({
          id: step.id,
          executable: step.executable,
          args: step.args,
          exit_code: 0,
          signal: null,
          timed_out: false,
          duration_ms: durationMs,
          observations: `Service stopped (PID ${service.pid})`,
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        errors.push(
          `Step "${step.id}" (service_stop) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        finalExitCode = finalExitCode || 1;
        stepResults.push({
          id: step.id,
          executable: step.executable,
          args: step.args,
          exit_code: -1,
          signal: null,
          timed_out: false,
          duration_ms: durationMs,
          observations: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
    } else {
      // ── command / probe: existing runProcess behavior ──
      const result = await runProcess({
        executable: step.executable,
        args: step.args,
        cwd: step.cwd,
        timeoutMs: step.timeout_ms,
      });

      // Capture observations (first 2000 chars)
      const observations = [
        result.stdout?.length > 0 ? `stdout: ${result.stdout.slice(0, 1000)}` : '',
        result.stderr?.length > 0 ? `stderr: ${result.stderr.slice(0, 1000)}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 2000) || undefined;

      const stepResult: StepResult = {
        id: step.id,
        executable: step.executable,
        args: step.args,
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
        observations,
      };

      stepResults.push(stepResult);

      // ── Check oracle expectations ──
      const expected = step.expected;

      // a. Check exit_code
      const expectedExitCode = expected?.exit_code ?? 0;
      if (result.exitCode !== expectedExitCode) {
        const detail = [
          `Step "${step.id}" exited with code ${result.exitCode} (expected ${expectedExitCode}).`,
          result.signal ? `Signal: ${result.signal}.` : '',
          result.timedOut ? 'Timed out.' : '',
          result.stderr ? `Stderr: ${result.stderr.slice(0, 500)}` : '',
        ]
          .filter(Boolean)
          .join(' ');

        errors.push(detail);
        finalExitCode = result.exitCode ?? -1;
        break;
      }

      // b. Check output_contains (stdout must contain the expected text)
      if (expected?.output_contains) {
        if (!result.stdout.includes(expected.output_contains)) {
          errors.push(
            `Step "${step.id}" stdout does not contain expected text "${expected.output_contains}". ` +
            `Stdout: ${result.stdout.slice(0, 500)}`,
          );
          finalExitCode = finalExitCode || 2;
          break;
        }
      }

      // c. Check output_matches (stdout must match the expected regex)
      if (expected?.output_matches) {
        try {
          const regex = new RegExp(expected.output_matches);
          if (!regex.test(result.stdout)) {
            errors.push(
              `Step "${step.id}" stdout does not match expected regex /${expected.output_matches}/. ` +
              `Stdout: ${result.stdout.slice(0, 500)}`,
            );
            finalExitCode = finalExitCode || 2;
            break;
          }
        } catch (regexErr) {
          errors.push(`Step "${step.id}" has invalid output_matches regex: ${regexErr}`);
          finalExitCode = finalExitCode || 2;
          break;
        }
      }

      // d. Check readiness_signal (merged stdout+stderr must contain signal)
      if (step.readiness_signal) {
        const combined = result.stdout + result.stderr;
        if (!combined.includes(step.readiness_signal)) {
          errors.push(
            `Step "${step.id}" readiness signal "${step.readiness_signal}" not found in output. ` +
            `Stdout: ${result.stdout.slice(0, 500)}`,
          );
          finalExitCode = finalExitCode || 2;
          break;
        }
      }

      // e. Check expected_observation (merged stdout+stderr must contain observation)
      if (step.expected_observation) {
        const combined = result.stdout + result.stderr;
        if (!combined.includes(step.expected_observation)) {
          errors.push(
            `Step "${step.id}" expected observation "${step.expected_observation}" not found. ` +
            `Stdout: ${result.stdout.slice(0, 500)}`,
          );
          finalExitCode = finalExitCode || 2;
          break;
        }
      }
    }
  }

  // ── 3. All steps skipped check ──
  if (executedCount === 0 && steps.length > 0) {
    errors.push('ALL_STEPS_SKIPPED: All runtime proof steps were marked not_applicable');
    finalExitCode = -1;
  }

  // ── 4. Cleanup ──
  // Determine which services have a declared service_stop in the manifest
  const serviceStopRefs = new Set(
    steps
      .filter(s => s.type === 'service_stop')
      .map(s => s.service_ref ?? s.id),
  );

  // Clean up any registered services first
  const serviceCleanup = await cleanupServices();

  // Check: if cleanup stopped a service that had an explicit service_stop declared,
  // it means the explicit stop was missed — this is a Gate FAIL.
  const missedExplicitStops = serviceCleanup.cleaned.filter(name =>
    serviceStopRefs.has(name),
  );
  for (const name of missedExplicitStops) {
    errors.push(
      `Service "${name}" was still running at final cleanup but has a declared ` +
      `service_stop step. The explicit stop was missed. This is a Gate FAIL.`,
    );
  }
  if (missedExplicitStops.length > 0 && finalExitCode === 0) {
    finalExitCode = -1;
  }

  if (serviceCleanup.failed.length > 0) {
    const details = serviceCleanup.failed
      .map(f => `${f.service} (PID ${f.pid}): ${f.reason}`)
      .join('; ');
    errors.push(`Service cleanup failures: ${details}`);
    if (finalExitCode === 0) finalExitCode = -1;
  }
  if (serviceCleanup.remainingPids.length > 0) {
    errors.push(
      `Services still running after cleanup: PIDs ${serviceCleanup.remainingPids.join(', ')}. ` +
      `Cleanup failure counts as Gate FAIL.`,
    );
    if (finalExitCode === 0) finalExitCode = -1;
  }

  if (knownPids.length > 0) {
    const result = await cleanupProcesses(knownPids);
    if (result.failed.length > 0) {
      errors.push(`Process cleanup failures: ${result.failed.join('; ')}`);
      if (finalExitCode === 0) finalExitCode = -1;
    }
  }

  // Check ports after cleanup
  if (knownPorts.length > 0) {
    const portsStillInUse = await checkPortsFree(knownPorts);
    if (portsStillInUse.length > 0) {
      errors.push(
        `Ports still in use after cleanup: ${portsStillInUse.join(', ')}. ` +
        `Cleanup failure counts as Gate FAIL.`,
      );
      if (finalExitCode === 0) finalExitCode = -1;
    }
  }

  return {
    success: errors.length === 0,
    stepResults,
    serviceCleanup,
    errors,
  };
}

// ── Stage Gate orchestrator ────────────────────────────────────────────────────

/**
 * Run all Runtime Proof steps from a compiled Stage Manifest.
 *
 * Flow:
 * 1. Load and validate Manifest
 * 2. Validate all RuntimeProofStep topology
 * 3. Execute each step in sequence via executeRuntimeProof
 * 4. Write structured receipt
 */
export async function runStageFromManifest(options: RunStageOptions): Promise<RunStageResult> {
  const errors: string[] = [];
  const { manifestPath, outputDir } = options;

  // ── 1. Load manifest ──
  if (!existsSync(manifestPath)) {
    return {
      success: false,
      errors: [`Manifest not found: ${manifestPath}`],
      stepCount: 0,
    };
  }

  let manifest: Manifest;
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    manifest = ManifestSchema.parse(parsed);
  } catch (err) {
    return {
      success: false,
      errors: [`Failed to parse manifest: ${err}`],
      stepCount: 0,
    };
  }

  // ── Validate Runtime Proof topology ──
  const topologyErrors = validateRuntimeProofTopology(manifest.runtime_proof ?? []);
  if (topologyErrors.length > 0) {
    return {
      success: false,
      errors: topologyErrors.map(e => `[${e.type}] ${e.message}`),
      stepCount: 0,
    };
  }

  const steps: RuntimeProofStep[] = manifest.runtime_proof ?? [];
  const resolvedOutputDir = outputDir ?? path.dirname(manifestPath);
  const platformInfo = getPlatformInfo();
  const startedAt = new Date();

  // ── Trivial fail: no steps → gate fails (proof without evidence) ──
  if (steps.length === 0) {
    errors.push('Stage Runtime Proof has zero steps — a proof with no evidence is not a valid pass.');
    const receiptPath = writeReceipt({
      outputDir: resolvedOutputDir,
      data: {
        stage_id: manifest.stage_id,
        snapshot: computeSnapshot(process.cwd()),
        platform: platformInfo.platform,
        tool_versions: {},
        steps: [],
        exit_code: 1,
        verdict: 'FAIL',
        timestamps: {
          started_at: startedAt.toISOString(),
          completed_at: new Date().toISOString(),
        },
      },
    });

    return { success: false, receiptPath, errors, stepCount: 0 };
  }

  // ── 2. Execute all steps via shared engine ──
  const execResult = await executeRuntimeProof(steps, {
    knownPids: options.knownPids,
    knownPorts: options.knownPorts,
  });

  // ── 3. Determine verdict ──
  const verdict = execResult.errors.length === 0 ? 'PASS' : 'FAIL';

  // ── 4. Write receipt ──
  const receiptPath = writeReceipt({
    outputDir: resolvedOutputDir,
    data: {
      stage_id: manifest.stage_id,
      snapshot: computeSnapshot(process.cwd()),
      platform: platformInfo.platform,
      tool_versions: { node: process.version },
      steps: execResult.stepResults,
      exit_code: execResult.errors.length > 0 ? 1 : 0,
      observations: execResult.errors.length > 0 ? execResult.errors.join('; ') : undefined,
      service_cleanup: execResult.serviceCleanup,
      verdict,
      timestamps: {
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
      },
    },
  });

  return {
    success: verdict === 'PASS',
    receiptPath,
    errors: execResult.errors,
    stepCount: steps.length,
  };
}

// ── Project Acceptance orchestrator ────────────────────────────────────────────

export interface RunProjectAcceptanceResult {
  success: boolean;
  receipt?: ProjectE2EReceipt;
  receiptPath?: string;
  errors: string[];
}

/**
 * Execute a Project Acceptance E2E run from a compiled ProjectAcceptanceManifest.
 *
 * Flow:
 * 1. Validate E2E step topology
 * 2. Execute each step in sequence via executeRuntimeProof
 * 3. Determine verdict (PROJECT_ACCEPTED / PROJECT_REJECTED)
 * 4. Write structured E2E receipt
 */
export async function runProjectAcceptance(
  manifest: ProjectAcceptanceManifest,
  outputDir?: string,
): Promise<RunProjectAcceptanceResult> {
  const errors: string[] = [];
  const resolvedOutputDir = outputDir ?? process.cwd();

  // ── 1. Validate E2E step topology ──
  const topologyErrors = validateRuntimeProofTopology(manifest.e2e_steps);
  if (topologyErrors.length > 0) {
    return {
      success: false,
      errors: topologyErrors.map(e => `[${e.type}] ${e.message}`),
    };
  }

  // ── 2. Execute E2E steps ──
  const execResult = await executeRuntimeProof(manifest.e2e_steps);

  // Merge execution errors
  for (const err of execResult.errors) {
    errors.push(err);
  }

  // ── 3. Determine verdict ──
  const verdict: ProjectE2EReceipt['verdict'] = execResult.success
    ? 'PROJECT_ACCEPTED'
    : 'PROJECT_REJECTED';

  // ── 4. Build receipt ──
  const e2eSteps = execResult.stepResults.map(sr => ({
    step_id: sr.id,
    exit_code: sr.exit_code,
    observations: sr.observations,
    skipped: sr.skipped,
  }));

  const receipt: ProjectE2EReceipt = {
    project_id: manifest.project_id,
    verdict,
    snapshot: computeSnapshot(process.cwd()),
    steps: e2eSteps,
    service_cleanup: execResult.serviceCleanup.cleaned.length > 0 || execResult.serviceCleanup.failed.length > 0
      ? execResult.serviceCleanup
      : undefined,
    created_at: new Date().toISOString(),
  };

  // ── 5. Write receipt ──
  mkdirSync(resolvedOutputDir, { recursive: true });
  const receiptPath = writeProjectE2EReceipt({
    outputDir: resolvedOutputDir,
    data: {
      project_id: manifest.project_id,
      verdict,
      snapshot: receipt.snapshot,
      steps: e2eSteps,
      service_cleanup: receipt.service_cleanup,
      created_at: receipt.created_at,
    },
  });

  return {
    success: execResult.success,
    receipt,
    receiptPath,
    errors,
  };
}

// ── CLI entry point ────────────────────────────────────────────────────────────

/**
 * CLI usage: `node dist/run-stage.js <manifest-path> [output-dir]`
 *
 * Exits with code 0 on PASS, 1 on FAIL/error.
 */
function isScriptEntry(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  const base = path.basename(scriptPath);
  return base === 'run-stage.js' || base === 'run-stage.ts';
}

if (isScriptEntry()) {
  const manifestPath = process.argv[2];
  const outputDir = process.argv[3];

  if (!manifestPath) {
    console.error('Usage: run-stage <manifest-path> [output-dir]');
    process.exit(1);
  }

  runStageFromManifest({ manifestPath, outputDir })
    .then((result) => {
      if (result.success) {
        console.log(`Stage Gate PASSED.`);
        console.log(`  Steps executed: ${result.stepCount}`);
        console.log(`  Receipt: ${result.receiptPath}`);
        process.exit(0);
      } else {
        console.error(`Stage Gate FAILED.`);
        console.error(`  Errors:`);
        for (const err of result.errors) {
          console.error(`    - ${err}`);
        }
        if (result.receiptPath) {
          console.error(`  Receipt: ${result.receiptPath}`);
        }
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}
