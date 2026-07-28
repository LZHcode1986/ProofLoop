import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Manifest, RuntimeProofStep } from './schemas.js';
import { runProcess, validateSpawnOptions } from './process-manager.js';
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
    manifest = JSON.parse(content) as Manifest;
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

  // ── Trivial pass: no steps → gate passes ──
  if (steps.length === 0) {
    const receiptPath = writeReceipt({
      outputDir: resolvedOutputDir,
      data: {
        stage_id: manifest.stage_id,
        snapshot: computeSnapshot(process.cwd()),
        platform: platformInfo.platform,
        tool_versions: {},
        steps: [],
        exit_code: 0,
        verdict: 'PASS',
        timestamps: {
          started_at: startedAt.toISOString(),
          completed_at: new Date().toISOString(),
        },
      },
    });

    return { success: true, receiptPath, errors: [], stepCount: 0 };
  }

  // ── 3. Execute each step sequentially ──
  for (const step of steps) {
    const result = await runProcess({
      executable: step.executable,
      args: step.args,
      cwd: step.cwd,
      timeoutMs: step.timeout_ms,
    });

    // Capture observations from stderr (first 2000 chars) if present
    const observations = result.stderr && result.stderr.length > 0
      ? result.stderr.slice(0, 2000)
      : undefined;

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

    // ── 4. Check expected exit code ──
    const expected = step.expected?.exit_code ?? 0;
    if (result.exitCode !== expected) {
      const detail = [
        `Step "${step.id}" exited with code ${result.exitCode} (expected ${expected}).`,
        result.signal ? `Signal: ${result.signal}.` : '',
        result.timedOut ? 'Timed out.' : '',
        result.stderr ? `Stderr (first 500 chars): ${result.stderr.slice(0, 500)}` : '',
      ]
        .filter(Boolean)
        .join(' ');

      errors.push(detail);
      finalExitCode = result.exitCode ?? -1;
      break; // Stop on first failure (fail-fast)
    }
  }

  // ── 5. Cleanup ──
  const knownPids = options.knownPids ?? [];
  const knownPorts = options.knownPorts ?? [];

  let cleanupResult: { cleaned: number; failed: string[] } | undefined;

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
