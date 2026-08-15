/**
 * Explicit vNext Planner compiler entry.
 *
 *   node packages/runtime/dist/cli/compile-vnext-manifest.js \
 *     <structured-input-json> <output-manifest-path> [project-root]
 *
 * The input is a strict JSON CompileVNextManifestInput.  This entry never
 * reads or infers a plan from Markdown and never calls the v1 compiler.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  type VNextManifest,
} from '@proofloop/kernel';
import {
  parseEntityRef,
  writeVNextManifest,
  type CompileVNextManifestInput,
  type VNextReferenceSeed,
  type VNextSliceSeed,
} from '../vnext';
import {
  adaptCandidateInputToCompileVNextManifestInput,
  isActiveCandidateInput,
} from '../vnext/candidate-input';
import {
  assertRootRelativePath,
  assertSameProjectRoot,
  errorMessage,
  isRecord,
  readJsonWithEmbeddedRoot,
  readRootBoundJson,
  resolveRootBoundPath,
  vnextError,
  type VNextCliError,
} from './vnext-cli-support-vnext';

// ============================================================
// Strict structured-input checks
// ============================================================

const INPUT_FIELDS = new Set([
  'root',
  'stage_id',
  'plan',
  'plan_path',
  'refs',
  'slices',
  'authority_ref_ids',
  'compiled_by',
]);

const REF_FIELDS = new Set(['ref_id', 'kind', 'ref']);
const SLICE_FIELDS = new Set([
  'slice_id',
  'proof_index',
  'required_skills',
  'depends_on',
  'evidence_path',
]);

function assertKnownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field} contains unknown field "${key}"`);
    }
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
}

export function assertStrictCompileInput(value: unknown, projectRoot: string): CompileVNextManifestInput {
  if (!isRecord(value)) {
    throw new Error('structured input must be a JSON object');
  }
  assertKnownFields(value, INPUT_FIELDS, 'structured input');

  if (typeof value.root !== 'string' || value.root.length === 0) {
    throw new Error('structured input.root must be a non-empty path');
  }
  assertSameProjectRoot(projectRoot, value.root);

  if (typeof value.stage_id !== 'string' || value.stage_id.length === 0) {
    throw new Error('structured input.stage_id must be a non-empty string');
  }
  if (!isRecord(value.plan)) {
    throw new Error('structured input.plan must be an object');
  }
  if (typeof value.plan_path !== 'string' || value.plan_path.length === 0) {
    throw new Error('structured input.plan_path must be a non-empty path');
  }
  assertRootRelativePath(projectRoot, value.plan_path, 'structured input.plan_path');

  if (!Array.isArray(value.refs)) {
    throw new Error('structured input.refs must be an array');
  }
  if (!Array.isArray(value.slices) || value.slices.length === 0) {
    throw new Error('structured input.slices must be a non-empty array');
  }

  const seenRefs = new Set<string>();
  for (const [index, rawRef] of value.refs.entries()) {
    if (!isRecord(rawRef)) {
      throw new Error(`structured input.refs[${index}] must be an object`);
    }
    assertKnownFields(rawRef, REF_FIELDS, `structured input.refs[${index}]`);
    if (typeof rawRef.ref_id !== 'string' || rawRef.ref_id.length === 0) {
      throw new Error(`structured input.refs[${index}].ref_id must be a non-empty string`);
    }
    if (seenRefs.has(rawRef.ref_id)) {
      throw new Error(`structured input.refs contains duplicate ref_id "${rawRef.ref_id}"`);
    }
    seenRefs.add(rawRef.ref_id);
    if (typeof rawRef.kind !== 'string' || rawRef.kind.length === 0) {
      throw new Error(`structured input.refs[${index}].kind must be a non-empty string`);
    }
    if (typeof rawRef.ref !== 'string' || rawRef.ref.length === 0) {
      throw new Error(`structured input.refs[${index}].ref must be a non-empty entity ref`);
    }
    const parsed = parseEntityRef(rawRef.ref);
    const relative = assertRootRelativePath(
      projectRoot,
      parsed.path,
      `structured input.refs[${index}].ref path`,
    );
    const canonicalRef = `${relative}#/entities/${parsed.entityId}`;
    if (rawRef.ref !== canonicalRef) {
      throw new Error(
        `structured input.refs[${index}].ref is not canonical: expected "${canonicalRef}"`,
      );
    }
  }

  const seenSlices = new Set<string>();
  const seenEvidence = new Set<string>();
  for (const [index, rawSlice] of value.slices.entries()) {
    if (!isRecord(rawSlice)) {
      throw new Error(`structured input.slices[${index}] must be an object`);
    }
    assertKnownFields(rawSlice, SLICE_FIELDS, `structured input.slices[${index}]`);
    if (typeof rawSlice.slice_id !== 'string' || rawSlice.slice_id.length === 0) {
      throw new Error(`structured input.slices[${index}].slice_id must be a non-empty string`);
    }
    if (seenSlices.has(rawSlice.slice_id)) {
      throw new Error(`structured input.slices contains duplicate slice_id "${rawSlice.slice_id}"`);
    }
    seenSlices.add(rawSlice.slice_id);
    if (!rawSlice.slice_id.startsWith(`${value.stage_id}-`)) {
      throw new Error(
        `structured input.slices[${index}].slice_id must be prefixed by stage_id "${value.stage_id}-"`,
      );
    }
    if (!isRecord(rawSlice.proof_index)) {
      throw new Error(`structured input.slices[${index}].proof_index must be an object`);
    }
    if (rawSlice.proof_index.slice_id !== rawSlice.slice_id) {
      throw new Error(
        `structured input.slices[${index}].proof_index.slice_id must equal slice_id`,
      );
    }
    assertStringArray(rawSlice.required_skills, `structured input.slices[${index}].required_skills`);
    assertStringArray(rawSlice.depends_on, `structured input.slices[${index}].depends_on`);
    if (typeof rawSlice.evidence_path !== 'string' || rawSlice.evidence_path.length === 0) {
      throw new Error(`structured input.slices[${index}].evidence_path must be a non-empty path`);
    }
    const evidencePath = assertRootRelativePath(
      projectRoot,
      rawSlice.evidence_path,
      `structured input.slices[${index}].evidence_path`,
    );
    if (seenEvidence.has(evidencePath)) {
      throw new Error(`structured input.slices contains duplicate evidence_path "${evidencePath}"`);
    }
    seenEvidence.add(evidencePath);
  }

  if (value.authority_ref_ids !== undefined) {
    assertStringArray(value.authority_ref_ids, 'structured input.authority_ref_ids');
  }
  if (value.compiled_by !== undefined && typeof value.compiled_by !== 'string') {
    throw new Error('structured input.compiled_by must be a string when present');
  }

  return value as unknown as CompileVNextManifestInput;
}

// ============================================================
// Bounded result and compiler seam
// ============================================================

export interface CompileVNextManifestCliResult {
  readonly success: boolean;
  readonly manifest_path: string | null;
  readonly manifest_digest: string | null;
  readonly stage_id: string | null;
  readonly schema_version: 2;
  readonly errors: readonly VNextCliError[];
}

function emptyResult(
  manifestPath: string | null = null,
  stageId: string | null = null,
  errors: readonly VNextCliError[] = [],
): CompileVNextManifestCliResult {
  return {
    success: false,
    manifest_path: manifestPath,
    manifest_digest: null,
    stage_id: stageId,
    schema_version: 2,
    errors,
  };
}

/**
 * Compile a vNext Manifest from a structured input file (S10-B-T01: shared
 * by the standalone CLI entry and the `plan compile` handler).  The result
 * is returned, never printed; the caller owns stdout/envelope handling.
 *
 * Mirrors the previous CLI-only flow: root assertion via embedded root,
 * strict/active candidate input checks, root-bound no-follow write target
 * checks, atomic compiler write, post-write digest readback.
 */
export function compileVNextManifestResult(
  inputPath: string,
  outputPath: string,
  assertedRoot?: string,
): CompileVNextManifestCliResult {
  let root: string;
  let rawInput: unknown;
  try {
    const loaded = readJsonWithEmbeddedRoot(inputPath, assertedRoot);
    root = loaded.root;
    rawInput = loaded.value;
  } catch (error) {
    return emptyResult(null, null, [vnextError('INPUT_READ_FAILED', errorMessage(error))]);
  }

  let input: CompileVNextManifestInput;
  let stageId: string | null = null;
  let target: string;
  try {
    if (isActiveCandidateInput(rawInput)) {
      input = adaptCandidateInputToCompileVNextManifestInput(rawInput, root);
    } else {
      input = assertStrictCompileInput(rawInput, root);
    }
    stageId = input.stage_id;
    target = resolveRootBoundPath(root, outputPath, 'output-manifest-path');
    // An existing symlink is never accepted as a write target, even when its
    // destination is still inside the root.  The writer itself remains the
    // atomic temp+rename implementation owned by the vNext compiler seam.
    const lexicalTarget = path.isAbsolute(outputPath)
      ? path.resolve(outputPath)
      : path.resolve(root, outputPath);
    if (target !== lexicalTarget) {
      throw new Error(`output-manifest-path traverses a symlink: "${outputPath}"`);
    }
    try {
      if (fs.lstatSync(lexicalTarget).isSymbolicLink()) {
        throw new Error(`output-manifest-path is a symlink: "${outputPath}"`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    return emptyResult(null, stageId, [vnextError('INPUT_INVALID', errorMessage(error))]);
  }

  try {
    const compiled = writeVNextManifest(input, target);
    if (compiled.manifest.version !== 2) {
      throw new Error('compiler returned a non-vNext Manifest; version 2 is required');
    }
    // JSON persistence omits optional `undefined` properties.  Digest the
    // root-bound persisted object, not the pre-serialization TypeScript value,
    // so the CLI result is exactly the digest of the emitted artifact.
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
    return emptyResult(target, stageId, [
      vnextError('COMPILE_FAILED', errorMessage(error), { path: target }),
    ]);
  }
}

export function compileVNextManifestCli(argv: readonly string[]): number {
  const [inputPath, outputPath, assertedRoot, ...extra] = argv;
  if (!inputPath || !outputPath || extra.length > 0) {
    const result = emptyResult(null, null, [
      vnextError(
        'USAGE',
        'Usage: node dist/cli/compile-vnext-manifest.js <structured-input-json> <output-manifest-path> [project-root]',
      ),
    ]);
    console.log(JSON.stringify(result));
    return 1;
  }

  const result = compileVNextManifestResult(inputPath, outputPath, assertedRoot);
  console.log(JSON.stringify(result));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = compileVNextManifestCli(process.argv.slice(2));
}

// Keep the compiler input types visible from the direct CLI module for
// downstream tests/adapters without exporting any v1 CLI surface.
export type { CompileVNextManifestInput, VNextReferenceSeed, VNextSliceSeed, VNextManifest };
