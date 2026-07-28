import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Manifest as ManifestSchema } from './schemas.js';
import type { Manifest, RuntimeProofStep, StepType } from './schemas.js';
import {
  runProcess,
  spawnService,
  registerService,
  getRegisteredService,
  stopRegisteredService,
  waitForReadiness,
  cleanupServices,
  validateSpawnOptions,
} from './process-manager.js';
import { writeReceipt, computeSnapshot, type StepResult } from './receipt-writer.js';
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

// ── Main orchestrator ──────────────────────────────────────────────────────────

/**
 * Run all Runtime Proof steps from a compiled Stage Manifest.
 *
 * Flow:
 * 1. Load and validate Manifest
 * 2. Validate all RuntimeProofStep definitions (no shells, no operators)
 * 3. Execute each step in sequence
 * 4. On first failure, stop and return FAIL verdict
 * 5. Cleanup known PIDs / ports
 * 6. Write structured receipt
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

  const steps: RuntimeProofStep[] = manifest.runtime_proof ?? [];
  const resolvedOutputDir = outputDir ?? path.dirname(manifestPath);
  const platformInfo = getPlatformInfo();
  const startedAt = new Date();
  const stepResults: StepResult[] = [];
  let finalExitCode = 0;

  // ── 2. Validate steps ──
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
      errors,
      stepCount: steps.length,
    };
  }

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

  // ── 3. Execute each step sequentially ──
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
      });
      continue;
    }

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

        let readinessFound = true;
        let readinessWaitMs = 0;

        if (step.readiness_signal) {
          const readinessTimeout = step.timeout_ms;
          const readyStart = Date.now();
          readinessFound = await waitForReadiness(handle, step.readiness_signal, readinessTimeout);
          readinessWaitMs = Date.now() - readyStart;
        }

        if (!readinessFound) {
          errors.push(
            `Step "${step.id}" (service_start) readiness signal "${step.readiness_signal}" not found within ${step.timeout_ms}ms. ` +
            `Stdout: ${handle.getStdout().slice(0, 500)}`,
          );
          finalExitCode = finalExitCode || 2;
          break;
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
      // ── service_stop: look up registered service and terminate ──
      const startTime = Date.now();
      const service = getRegisteredService(step.id);

      if (!service) {
        errors.push(
          `Step "${step.id}" (service_stop): no registered service found with id "${step.id}". ` +
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
          observations: `Error: no registered service "${step.id}"`,
        });
        break;
      }

      try {
        await stopRegisteredService(step.id);
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

      // ── 4. Check oracle expectations ──
      const expected = step.expected;

      // 4a. Check exit_code
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

      // 4b. Check output_contains (stdout must contain the expected text)
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

      // 4c. Check output_matches (stdout must match the expected regex)
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

      // 4d. Check readiness_signal (merged stdout+stderr must contain signal)
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

      // 4e. Check expected_observation (merged stdout+stderr must contain observation)
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

  // ── 5. Cleanup ──
  const knownPids = options.knownPids ?? [];
  const knownPorts = options.knownPorts ?? [];

  let cleanupResult: { cleaned: number; failed: string[] } | undefined;

  // Clean up any registered services first
  await cleanupServices();

  if (knownPids.length > 0) {
    const { cleanupProcesses } = await import('./process-manager.js');
    cleanupResult = await cleanupProcesses(knownPids);
  }

  // Check ports after cleanup
  let portsStillInUse: number[] = [];
  if (knownPorts.length > 0) {
    const { checkPortsFree } = await import('./process-manager.js');
    portsStillInUse = await checkPortsFree(knownPorts);
    if (portsStillInUse.length > 0) {
      errors.push(
        `Ports still in use after cleanup: ${portsStillInUse.join(', ')}. ` +
        `Cleanup failure counts as Gate FAIL.`,
      );
      if (finalExitCode === 0) finalExitCode = -1;
    }
  }

  // ── 6. Determine verdict ──
  const verdict = errors.length === 0 ? 'PASS' : 'FAIL';

  // ── 7. Write receipt ──
  const receiptPath = writeReceipt({
    outputDir: resolvedOutputDir,
    data: {
      stage_id: manifest.stage_id,
      snapshot: computeSnapshot(process.cwd()),
      platform: platformInfo.platform,
      tool_versions: { node: process.version },
      steps: stepResults,
      exit_code: finalExitCode,
      observations: errors.length > 0 ? errors.join('; ') : undefined,
      cleanup: cleanupResult,
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
    errors,
    stepCount: steps.length,
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
