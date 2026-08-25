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
import { writeVNextManifest } from './vnext/compiler';

export { detectPlanManifestRoute } from './vnext/manifest-route';
export type { PlanManifestRoute } from './vnext/manifest-route';

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
