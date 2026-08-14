/**
 * Runtime-owned plan operation seams.
 *
 * These services keep the Host operation router thin: v1 remains on its
 * existing library path, while explicit candidate/v2 operations use the
 * additive vNext compiler, validator and Evidence initializer.  No service in
 * this module performs SPV, admission, Receipt or Stage execution work.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest } from '@proofloop/kernel';
import { canonicalPathWithinRoot } from './path-guard';
import {
  errorMessage,
  readRootBoundJson,
  resolveProjectRoot,
  resolveRootBoundPath,
  vnextError,
  type VNextCliError,
} from './cli/vnext-cli-support-vnext';
import { assertStrictCompileInput } from './cli/compile-vnext-manifest';
import {
  initializeVNextSliceEvidence,
  type InitializeVNextSliceEvidenceResult,
} from './cli/initialize-vnext-slice-evidence';
import {
  validateVNextStage,
  type ValidateVNextStageResult,
} from './cli/validate-vnext-stage';
import {
  adaptCandidateInputToCompileVNextManifestInput,
  CandidateInputError,
  isActiveCandidateInput,
} from './vnext/candidate-input';
import {
  readRootBoundFile,
  VNextEntityResolutionError,
} from './vnext/entity-resolver';
import { writeVNextManifest } from './vnext/compiler';

export type PlanManifestRoute = 'v1' | 'vnext' | 'unknown';

/**
 * Inspect only the root-bound Manifest discriminator.
 *
 * The read itself is part of the route boundary: no-follow, regular-file and
 * post-read identity failures are route failures, never evidence of a legacy
 * Manifest.  A successfully read file selects v1 only with an explicit legacy
 * marker (`version: 1`) or the legacy stage/source shape used by the existing
 * v1 Manifest contract.  The one compatibility exception is an absent
 * default artifact, which remains on the legacy consumer so status/next retain
 * their canonical missing-Manifest finding. Any explicit vNext-like shape or
 * unknown discriminator is bounded as `unknown`, never silently downgraded.
 */
export function detectPlanManifestRoute(
  projectRoot: string,
  manifestPath: string,
): PlanManifestRoute {
  const root = resolveProjectRoot(projectRoot);
  if (canonicalPathWithinRoot(root, manifestPath) === null) return 'unknown';
  let value: unknown;
  try {
    // `readRootBoundJson` intentionally keeps a broad error shape for CLI
    // projections. Route detection needs the stronger read boundary instead:
    // it must not turn no-follow symlink, non-regular, read or TOCTOU errors
    // into a legacy route.
    const read = readRootBoundFile(root, manifestPath);
    value = JSON.parse(read.content) as unknown;
  } catch (error) {
    // A missing default artifact is still handed to the legacy consumer so
    // status/next preserve their canonical DOMAIN.STAGE_NOT_FOUND result.  A
    // path that existed and then disappeared is a TOCTOU failure, and every
    // other read/no-follow/regular-file failure remains an unknown route.
    if (error instanceof VNextEntityResolutionError && error.code === 'unreadable') {
      const probePath = path.isAbsolute(manifestPath)
        ? manifestPath
        : path.resolve(root, manifestPath);
      try {
        fs.lstatSync(probePath);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ENOENT') return 'v1';
      }
    }
    return 'unknown';
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const record = value as Record<string, unknown>;
  const version = record.version;
  const schemaVersion = record.schema_version;
  if (version !== undefined && version !== 1 && version !== 2) return 'unknown';
  if (schemaVersion !== undefined && schemaVersion !== 2) return 'unknown';
  const plan = record.plan;
  if (plan !== undefined && (plan === null || typeof plan !== 'object' || Array.isArray(plan))) {
    return 'unknown';
  }
  const planSchemaVersion =
    plan === undefined ? undefined : (plan as Record<string, unknown>).schema_version;
  if (plan !== undefined && planSchemaVersion !== 2) return 'unknown';
  const hasVNextMarker = version === 2 || schemaVersion === 2 || planSchemaVersion === 2;
  if (version === 1 && hasVNextMarker) return 'unknown';
  if (hasVNextMarker) return 'vnext';
  if (version === 1) return 'v1';
  // Current v1 manifests predate the discriminator and are identified by the
  // required stage/source anchors. Keep that legacy route for status/next
  // compatibility without treating an arbitrary JSON object as v1.
  return typeof record.stage_id === 'string' && typeof record.source_path === 'string'
    ? 'v1'
    : 'unknown';
}

export interface CompileVNextPlanInput {
  readonly projectRoot: string;
  readonly candidateInputPath: string;
  readonly manifestPath: string;
}

export interface CompileVNextPlanResult {
  readonly success: boolean;
  readonly manifest_path: string | null;
  readonly manifest_digest: string | null;
  readonly stage_id: string | null;
  readonly schema_version: 2;
  readonly errors: readonly VNextCliError[];
}

function compileFailure(
  stageId: string | null,
  errors: readonly VNextCliError[],
  manifestPath: string | null = null,
): CompileVNextPlanResult {
  return {
    success: false,
    manifest_path: manifestPath,
    manifest_digest: null,
    stage_id: stageId,
    schema_version: 2,
    errors,
  };
}

function stageIdFromCandidatePath(value: unknown): string | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).stage_id === 'string'
    ? (value as Record<string, unknown>).stage_id as string
    : null;
}

function assertWriteTarget(root: string, requested: string): string {
  const target = resolveRootBoundPath(root, requested, 'output-manifest-path');
  const lexical = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  if (target !== lexical) {
    throw new Error(`output-manifest-path traverses a symlink: "${requested}"`);
  }
  try {
    if (fs.lstatSync(lexical).isSymbolicLink()) {
      throw new Error(`output-manifest-path is a symlink: "${requested}"`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

function mapCandidateError(error: unknown): VNextCliError {
  if (error instanceof CandidateInputError) {
    const type =
      error.code === 'path-escape'
        ? 'PATH_ESCAPE'
        : error.code === 'root-mismatch'
          ? 'ROOT_MISMATCH'
          : error.code === 'reference-binding'
            ? 'REFERENCE_BINDING_INVALID'
            : error.code === 'candidate-only'
              ? 'CANDIDATE_NOT_ONLY'
              : 'CANDIDATE_INPUT_INVALID';
    return vnextError(type, error.message);
  }
  return vnextError('COMPILE_INPUT_INVALID', errorMessage(error));
}

/**
 * Compile the active structured candidate input into a version-2 Manifest.
 * The candidate input is read through the Runtime no-follow/TOCTOU boundary;
 * the Markdown candidate path is used only as an explicit reference source by
 * the existing entity resolver, never as a plan parser.
 */
export function compileVNextPlan(
  input: CompileVNextPlanInput,
): CompileVNextPlanResult {
  let root: string;
  let stageId: string | null = null;
  let target: string | null = null;
  try {
    root = resolveProjectRoot(input.projectRoot);
    const candidateRead = readRootBoundJson(root, input.candidateInputPath, 'candidate input');
    stageId = stageIdFromCandidatePath(candidateRead.value);
    const compilerInput = isActiveCandidateInput(candidateRead.value)
      ? adaptCandidateInputToCompileVNextManifestInput(candidateRead.value, root)
      : assertStrictCompileInput(candidateRead.value, root);
    target = assertWriteTarget(root, input.manifestPath);
    const compiled = writeVNextManifest(compilerInput, target);
    if (compiled.manifest.version !== 2) {
      throw new Error('vNext compiler returned a non-version-2 Manifest');
    }
    const persisted = readRootBoundJson(root, target, 'written vNext manifest').value;
    const manifestDigest = computeDigest(persisted);
    const expectedDigest = computeDigest(JSON.parse(JSON.stringify(compiled.manifest)) as unknown);
    if (manifestDigest !== expectedDigest) {
      throw new Error('written vNext Manifest changed during the post-write TOCTOU check');
    }
    return {
      success: true,
      manifest_path: target,
      manifest_digest: manifestDigest,
      stage_id: compiled.manifest.stage_id,
      schema_version: 2,
      errors: [],
    };
  } catch (error) {
    return compileFailure(stageId, [mapCandidateError(error)], target);
  }
}

/** Alias naming the active candidate source explicitly. */
export const compileVNextPlanFromCandidate = compileVNextPlan;

/** Runtime public service seam for vNext mechanical validation. */
export function validateVNextPlanStage(
  tasksPath: string,
  manifestPath: string,
  evidenceDir: string | undefined,
  projectRoot: string,
): ValidateVNextStageResult {
  return validateVNextStage(tasksPath, manifestPath, evidenceDir, projectRoot);
}

/** Runtime public service seam for vNext Evidence initialization. */
export function initializeVNextPlanEvidence(
  manifestPath: string,
  evidenceDir: string | undefined,
  projectRoot: string,
): InitializeVNextSliceEvidenceResult {
  return initializeVNextSliceEvidence(manifestPath, evidenceDir, projectRoot);
}
