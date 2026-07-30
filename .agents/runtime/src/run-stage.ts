import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { CvReceipt as CvReceiptSchema, Manifest as ManifestSchema, ProjectAcceptanceManifestSchema, SliceCompleteFacts as SliceCompleteFactsSchema, SliceCommitReceipt as SliceCommitReceiptSchema, SliceIntegrationReceipt } from './schemas.js';
import type { Manifest, RuntimeProofStep, StepType, ProjectAcceptanceManifest, ProjectE2EReceipt, SliceCompleteFacts, CvReceipt } from './schemas.js';
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
import { writeGateReceipt, writeProjectE2EReceipt, computeSnapshot, type StepResult } from './receipt-writer.js';
import { getPlatformInfo } from './platform-adapter.js';
import { computeCanonicalJsonDigest } from './canonical-digest.js';
import { resolveCanonicalArtifact, assertRegularFileBelowTrustedRoot } from './canonical-artifact-path.js';
import { findLatestIntegrationReceipt } from './slice-boundary-receipts.js';

// ── Persisted Slice COMPLETE evidence ──────────────────────────────────────────

/**
 * Resolve a persisted evidence reference without treating the reference itself
 * as evidence. Delegates to the shared `resolveCanonicalArtifact` module
 * which searches multiple candidate locations and validates the result.
 */
function resolveEvidenceFile(reference: string, outputDir: string): string | null {
  return resolveCanonicalArtifact(reference, outputDir);
}

function hasPersistedCvReceipt(
  reference: string,
  stageId: string,
  sliceId: string,
  trustRoot: string,
): string | null {
  const receiptPath = resolveEvidenceFile(reference, trustRoot);
  if (!receiptPath) return null;
  try {
    const parsed = CvReceiptSchema.safeParse(JSON.parse(readFileSync(receiptPath, 'utf-8')));
    if (!parsed.success || parsed.data.stage_id !== stageId || parsed.data.slice_id !== sliceId || parsed.data.verdict !== 'PASS' || (parsed.data.scope_violations?.length ?? 0) > 0) {
      return null;
    }
    return receiptPath;
  } catch {
    return null;
  }
}

function hasPersistedCommit(commitSha: string, projectRoot: string): boolean {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) return false;
  try {
    // Git is the persistence boundary for a commit fact.  Checking the object
    // prevents a caller from smuggling an arbitrary nonempty commit label.
    execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function hasCommitAncestor(commitSha: string, projectRoot: string): { exists: boolean; ancestor: boolean } {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) return { exists: false, ancestor: false };
  try {
    // First verify the commit object exists
    execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    // Then verify it's an ancestor of HEAD
    execFileSync('git', ['merge-base', '--is-ancestor', commitSha, 'HEAD'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return { exists: true, ancestor: true };
  } catch {
    // If cat-file succeeded but merge-base failed, commit exists but isn't ancestor
    try {
      execFileSync('git', ['cat-file', '-e', `${commitSha}^{commit}`], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
      return { exists: true, ancestor: false };
    } catch {
      return { exists: false, ancestor: false };
    }
  }
}

/**
 * Return the current HEAD commit SHA from the git repository.
 * Returns null if git is unavailable or not in a repository.
 */
function getHeadSha(projectRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

function hasPersistedIntegration(
  reference: string,
  stageId: string,
  sliceId: string,
  commitSha: string,
  trustRoot: string,
): string | null {
  const artifactPath = resolveEvidenceFile(reference, trustRoot);
  if (!artifactPath) return null;
  try {
    const content = readFileSync(artifactPath, 'utf-8').trim();
    if (!content) return null;
    // An integration reference is evidence only when its persisted record
    // carries the complete identity tuple. A non-JSON label, or a JSON object
    // that omits any binding field, is just caller-supplied text and cannot
    // authorize Slice COMPLETE.
    if (!artifactPath.toLowerCase().endsWith('.json')) return null;
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.stage_id !== stageId || record.slice_id !== sliceId || record.commit_sha !== commitSha) return null;
    if (record.status !== 'integrated') return null;
    return artifactPath;
  } catch {
    return null;
  }
}

/**
 * Validate that fact.commit.receipt_ref points to a valid Committer Receipt
 * that matches the fact's commit_sha, the CV receipt, etc.
 * Returns the canonical path of the Committer Receipt, or null if invalid.
 */
function validateFactCommitReceipt(
  projectRoot: string,
  stageId: string,
  sliceId: string,
  commitSha: string,
  receiptRef: string,
  cvReceiptPath: string,
): string | null {
  // 1. Resolve the specific receipt ref through canonical path
  const resolvedPath = resolveCanonicalArtifact(receiptRef, projectRoot);
  if (!resolvedPath) return null;

  // 2. Parse and validate
  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    const parsed = SliceCommitReceiptSchema.parse(JSON.parse(content));

    // 3. Match stage/slice
    if (parsed.stage_id !== stageId || parsed.slice_id !== sliceId) return null;
    if (parsed.status !== 'committed') return null;

    // 4. Match commit_sha
    if (parsed.slice_commit_sha !== commitSha) return null;

    // 5. Verify commit is an ancestor of HEAD
    const { exists, ancestor } = hasCommitAncestor(commitSha, projectRoot);
    if (!exists || !ancestor) return null;

    // 6. Match CV receipt — resolve both to canonical paths for comparison
    const canonicalCvInReceipt = resolveCanonicalArtifact(parsed.cv_receipt_ref, projectRoot);
    if (!canonicalCvInReceipt || canonicalCvInReceipt !== cvReceiptPath) return null;

    return resolvedPath;
  } catch {
    return null;
  }
}

function validatePersistedSliceFacts(
  facts: SliceCompleteFacts[],
  stageId: string,
  trustRoot: string,
): { facts: SliceCompleteFacts[]; errors: string[] } {
  const errors: string[] = [];
  const persistedFacts: SliceCompleteFacts[] = [];

  // Resolve HEAD once for all fact validation in this batch.
  const headSha = getHeadSha(trustRoot);

  for (const fact of facts) {
    // ── 1. Resolve and validate CV PASS receipt ────────────────────────────
    const cvReceiptPath = resolveCanonicalArtifact(fact.cv.receipt_ref, trustRoot);
    if (!cvReceiptPath) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: CV receipt ${fact.cv.receipt_ref} not found or is outside trust root.`);
      continue;
    }

    let cvReceipt: CvReceipt;
    try {
      const parsed = CvReceiptSchema.safeParse(JSON.parse(readFileSync(cvReceiptPath, 'utf-8')));
      if (!parsed.success) {
        errors.push(`Slice COMPLETE fact for ${fact.slice_id}: CV receipt at ${cvReceiptPath} is invalid: ${parsed.error.message}`);
        continue;
      }
      cvReceipt = parsed.data;
    } catch {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: CV receipt at ${cvReceiptPath} is unreadable.`);
      continue;
    }

    if (cvReceipt.verdict !== 'PASS') {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: CV receipt verdict is ${cvReceipt.verdict}, expected PASS.`);
      continue;
    }
    if (cvReceipt.stage_id !== stageId || cvReceipt.slice_id !== fact.slice_id) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: CV receipt stage/slice mismatch.`);
      continue;
    }

    // ── 2. Validate the specific Committer Receipt referenced by fact.commit.receipt_ref ──
    const commitPath = validateFactCommitReceipt(
      trustRoot,
      stageId,
      fact.slice_id,
      fact.commit.commit_sha,
      fact.commit.receipt_ref,
      cvReceiptPath,
    );
    if (!commitPath) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: invalid Committer Receipt at ${fact.commit.receipt_ref}.`);
      continue;
    }

    // ── 6. Find and validate Integration Receipt ───────────────────────────
    const integrationResult = findLatestIntegrationReceipt(trustRoot, stageId, fact.slice_id, fact.commit.commit_sha);
    if (!integrationResult) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: no valid Integration Receipt found for commit ${fact.commit.commit_sha}.`);
      continue;
    }

    const integrationReceipt = integrationResult.receipt;

    // 7. Integration Receipt.slice_commit_sha === fact.commit.commit_sha
    if (integrationReceipt.slice_commit_sha !== fact.commit.commit_sha) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: integration slice_commit_sha mismatch.`);
      continue;
    }

    // 8. Integration Receipt.cv_receipt_ref (canonical) === fact.cv.receipt_ref (canonical)
    const canonicalIntegrationCvRef = resolveCanonicalArtifact(integrationReceipt.cv_receipt_ref, trustRoot);
    if (!canonicalIntegrationCvRef || canonicalIntegrationCvRef !== cvReceiptPath) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: CV receipt ref mismatch between fact and Integration Receipt.`);
      continue;
    }

    // 9. Integration Receipt.verified_snapshot === CV Receipt.snapshot
    if (integrationReceipt.verified_snapshot !== cvReceipt.snapshot) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: snapshot mismatch (CV: ${cvReceipt.snapshot}, Integration: ${integrationReceipt.verified_snapshot}).`);
      continue;
    }

    // 10. Integration Receipt.integrated_commit_sha is ancestor of HEAD
    //     Already validated by findLatestIntegrationReceipt.

    // ── Commit ancestry check (catch-all) ──────────────────────────────────
    if (headSha === null) {
      errors.push(`Slice COMPLETE fact for ${fact.slice_id}: cannot determine HEAD commit.`);
      continue;
    }

    // All checks passed — store with canonical receipt paths.
    persistedFacts.push({
      ...fact,
      cv: { ...fact.cv, receipt_ref: cvReceiptPath },
      commit: { ...fact.commit, receipt_ref: commitPath },
      integration: { ...fact.integration, integration_ref: integrationResult.path },
    });
  }

  return { facts: persistedFacts, errors };
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunStageOptions {
  manifestPath: string;
  /** Project root directory — trusted boundary for input artifact resolution.  Defaults to process.cwd(). */
  projectRoot?: string;
  /** Output directory for the Stage Gate receipt.  Defaults to .proofloop/receipts/stage-gate/<stage_id>. */
  outputDir?: string;
  knownPids?: number[];
  knownPorts?: number[];
  /** Persisted Slice COMPLETE facts; PASS is impossible without one per manifest slice. */
  sliceCompleteFacts?: SliceCompleteFacts[];
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
  /** Project root for resolving relative step cwds.  Defaults to process.cwd(). */
  projectRoot?: string;
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

    // Resolve step cwd relative to projectRoot when provided.
    const effectiveProjectRoot = options?.projectRoot ?? process.cwd();
    const stepCwdValue = step.cwd ?? '.';
    const stepCwd = path.isAbsolute(stepCwdValue)
      ? stepCwdValue
      : path.resolve(effectiveProjectRoot, stepCwdValue);

    const stepType: StepType = step.type ?? 'command';

    if (stepType === 'service_start') {
      // ── service_start: spawn, register, wait for readiness ──
      const startTime = Date.now();

      try {
        const handle = await spawnService({
          executable: step.executable,
          args: step.args,
          cwd: stepCwd,
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
        cwd: stepCwd,
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
  const { manifestPath, outputDir, projectRoot } = options;

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
  const resolvedProjectRoot = projectRoot ?? path.resolve(process.cwd());
  const resolvedOutputDir = outputDir ?? path.resolve(resolvedProjectRoot, '.proofloop', 'receipts', 'stage-gate', manifest.stage_id);
  const suppliedFacts = options.sliceCompleteFacts ?? [];
  const parsedFacts = suppliedFacts.map(fact => SliceCompleteFactsSchema.safeParse(fact));
  const factErrors: string[] = [];
  if (suppliedFacts.length !== manifest.slices.length) {
    factErrors.push(`Slice COMPLETE facts must contain exactly one fact per manifest slice (expected ${manifest.slices.length}, got ${suppliedFacts.length}).`);
  }
  if (parsedFacts.some(parsed => !parsed.success)) factErrors.push('Slice COMPLETE facts contain an invalid commit, integration, or CV receipt fact.');
  const structurallyValidFacts = parsedFacts
    .filter((parsed): parsed is { success: true; data: SliceCompleteFacts } => parsed.success)
    .map(parsed => parsed.data);
  const factIds = structurallyValidFacts.map(fact => fact.slice_id);
  const manifestIds = manifest.slices.map(slice => slice.slice_id);
  if (new Set(factIds).size !== factIds.length || factIds.length !== manifestIds.length || manifestIds.some(id => !factIds.includes(id))) {
    factErrors.push('Slice COMPLETE facts must uniquely cover every manifest slice.');
  }

  // Validate every reference against persisted artifacts before a PASS can be
  // selected. Caller-provided strings are never copied into a PASS receipt.
  const persistedFactsResult = validatePersistedSliceFacts(structurallyValidFacts, manifest.stage_id, resolvedProjectRoot);
  factErrors.push(...persistedFactsResult.errors);
  const validFacts = persistedFactsResult.facts;
  const platformInfo = getPlatformInfo();
  const startedAt = new Date();

  // Compute canonical manifest digest
  const manifestDigest = computeCanonicalJsonDigest(ManifestSchema, manifest);

  // ── Trivial fail: no steps → gate fails (proof without evidence) ──
  if (steps.length === 0) {
    errors.push('Stage Runtime Proof has zero steps — a proof with no evidence is not a valid pass.');
    errors.push(...factErrors);
    const receiptPath = writeGateReceipt(resolvedOutputDir, {
      stage_id: manifest.stage_id,
      snapshot: computeSnapshot(resolvedProjectRoot),
      manifest_digest: manifestDigest,
      completed_slice_ids: validFacts.map(fact => fact.slice_id),
      slice_complete_facts: validFacts,
      manifest_path: manifestPath,
      platform: platformInfo.platform,
      verdict: 'FAIL',
      steps: [],
      service_cleanup: { cleaned: [], failed: [], remainingPids: [] },
      timestamps: {
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
      },
    });

    return { success: false, receiptPath, errors, stepCount: 0 };
  }

  // ── 2. Execute all steps via shared engine ──
  const execResult = await executeRuntimeProof(steps, {
    knownPids: options.knownPids,
    knownPorts: options.knownPorts,
    projectRoot: resolvedProjectRoot,
  });

  // ── 3. Determine verdict ──
  const verdict = execResult.errors.length === 0 && factErrors.length === 0 ? 'PASS' : 'FAIL';
  errors.push(...factErrors);

  // ── 4. Write receipt ──
  const receiptPath = writeGateReceipt(resolvedOutputDir, {
    stage_id: manifest.stage_id,
    snapshot: computeSnapshot(resolvedProjectRoot),
    manifest_digest: manifestDigest,
    completed_slice_ids: validFacts.map(fact => fact.slice_id),
    slice_complete_facts: validFacts,
    manifest_path: manifestPath,
    platform: platformInfo.platform,
    verdict,
    steps: execResult.stepResults,
    service_cleanup: execResult.serviceCleanup,
    timestamps: {
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
    },
  });

  return {
    success: verdict === 'PASS',
    receiptPath,
    errors: [...execResult.errors, ...factErrors],
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
 * 0. Check for zero steps or all-skipped (reject empty proofs)
 * 1. Validate E2E step topology
 * 2. Execute each step in sequence via executeRuntimeProof
 * 3. Determine verdict (PASS / FAIL / BLOCKED)
 * 4. Write structured E2E receipt with manifest digest and source snapshot
 */
export async function runProjectAcceptance(
  manifest: ProjectAcceptanceManifest,
  outputDir?: string,
  projectRoot?: string,
): Promise<RunProjectAcceptanceResult> {
  const errors: string[] = [];
  const root = projectRoot ?? process.cwd();
  const resolvedOutputDir = outputDir ?? root;

  // ── 0. Zero-step / all-skipped rejection ──
  if (manifest.e2e_steps.length === 0) {
    return {
      success: false,
      errors: ['PROJECT_E2E_ZERO_STEPS: Project Acceptance requires at least one E2E step'],
    };
  }

  const allSkipped = manifest.e2e_steps.every(s => s.not_applicable?.reason);
  if (allSkipped) {
    return {
      success: false,
      errors: ['PROJECT_E2E_ALL_SKIPPED: All E2E steps are not_applicable; a proof with no evidence is not valid'],
    };
  }

  // ── 1. Validate E2E step topology ──
  const topologyErrors = validateRuntimeProofTopology(manifest.e2e_steps);
  if (topologyErrors.length > 0) {
    return {
      success: false,
      errors: topologyErrors.map(e => `[${e.type}] ${e.message}`),
    };
  }

  // ── 1b. Snapshot comparison ──
  const executedSnapshot = computeSnapshot(root);

  if (manifest.expected_snapshot !== executedSnapshot) {
    return {
      success: false,
      errors: [
        `PROJECT_SOURCE_STALE: expected snapshot "${manifest.expected_snapshot}" does not match executed "${executedSnapshot}"`,
      ],
    };
  }

  // ── 2. Execute E2E steps ──
  const execResult = await executeRuntimeProof(manifest.e2e_steps);

  // Merge execution errors
  for (const err of execResult.errors) {
    errors.push(err);
  }

  // ── 3. Determine verdict ──
  const verdict: ProjectE2EReceipt['verdict'] = execResult.success ? 'PASS' : 'FAIL';

  // ── 4. Build receipt ──
  const e2eSteps = execResult.stepResults.map(sr => ({
    step_id: sr.id,
    exit_code: sr.exit_code,
    observations: sr.observations,
    skipped: sr.skipped,
  }));

  // Compute manifest digest using shared canonical function
  const manifestDigest = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, manifest);

  const receipt: ProjectE2EReceipt = {
    project_id: manifest.project_id,
    verdict,
    snapshot: computeSnapshot(root),
    manifest_digest: manifestDigest,
    expected_snapshot: manifest.expected_snapshot,
    executed_snapshot: executedSnapshot,
    steps: e2eSteps,
    service_cleanup: execResult.serviceCleanup,
    created_at: new Date().toISOString(),
  };

  // ── 5. Write receipt ──
  mkdirSync(resolvedOutputDir, { recursive: true });
  const receiptPath = writeProjectE2EReceipt(resolvedOutputDir, {
    project_id: manifest.project_id,
    verdict,
    snapshot: receipt.snapshot,
    manifest_digest: manifestDigest,
    expected_snapshot: receipt.expected_snapshot,
    executed_snapshot: executedSnapshot,
    steps: e2eSteps,
    service_cleanup: execResult.serviceCleanup,
    created_at: receipt.created_at,
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
 * CLI handler for run-stage command.
 *
 * Usage: `run-stage <manifest-path> <slice-complete-facts-path> [output-dir]`
 *
 * Reads a JSON array of SliceCompleteFacts from `<slice-complete-facts-path>`
 * and passes it to runStageFromManifest.  Exits with code 0 on PASS, 1 on
 * FAIL/error.  Missing, malformed, or non-array facts exit with code 1 and
 * a clear error message before calling runStageFromManifest.
 */
export async function runStageCli(argv: string[]): Promise<number> {
  const [manifestPath, factsPath, outputDir, projectRoot] = argv;

  if (!manifestPath || !factsPath) {
    console.error('Usage: run-stage <manifest-path> <slice-complete-facts-path> [output-dir] [project-root]');
    return 1;
  }

  // ── Validate Slice COMPLETE facts file ──
  if (!existsSync(factsPath)) {
    console.error(`Slice COMPLETE facts file not found: ${factsPath}`);
    return 1;
  }

  let parsedFacts: unknown;
  try {
    const content = readFileSync(factsPath, 'utf-8');
    parsedFacts = JSON.parse(content);
  } catch (err) {
    console.error(`Failed to parse Slice COMPLETE facts file: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!Array.isArray(parsedFacts)) {
    console.error('Slice COMPLETE facts file must contain a JSON array.');
    return 1;
  }

  // The array elements are validated by runStageFromManifest via schema
  // parsing inside the function — we do not duplicate that validation here.
  try {
    const result = await runStageFromManifest({
      manifestPath,
      outputDir,
      projectRoot: projectRoot ? path.resolve(projectRoot) : undefined,
      sliceCompleteFacts: parsedFacts as SliceCompleteFacts[],
    });

    if (result.success) {
      console.log(`Stage Gate PASSED.`);
      console.log(`  Steps executed: ${result.stepCount}`);
      console.log(`  Receipt: ${result.receiptPath}`);
      return 0;
    } else {
      console.error(`Stage Gate FAILED.`);
      console.error(`  Errors:`);
      for (const err of result.errors) {
        console.error(`    - ${err}`);
      }
      if (result.receiptPath) {
        console.error(`  Receipt: ${result.receiptPath}`);
      }
      return 1;
    }
  } catch (err) {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function isScriptEntry(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  const base = path.basename(scriptPath);
  return base === 'run-stage.js' || base === 'run-stage.ts';
}

if (isScriptEntry()) {
  runStageCli(process.argv.slice(2)).then((code) => process.exit(code));
}
