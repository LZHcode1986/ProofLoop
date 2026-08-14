/**
 * @proofloop/runtime — vNext Manifest compiler seam (S0-A bootstrap, task 2).
 *
 * Provides the versioned Runtime API that lets Planners / Executors consume
 * the kernel vNext contract surface:
 *   - resolveVNextReference          (see entity-resolver.ts — read-only seam)
 *   - compileVNextManifest          (structured vNext input → validated manifest)
 *   - writeVNextManifest            (compile + FULL validate, then atomic write)
 *   - kernel vNext validators re-exported for a single import path.
 *
 * Rules (fail closed):
 *   - Takes ONLY structured vNext input or already-resolved entity/ref
 *     descriptors. It NEVER infers commands, Proof obligations or
 *     acceptance from arbitrary Markdown body text.
 *   - Every input passes the kernel `validateVNextPlan` /
 *     `validateVNextReferenceIndex` / `validateVNextProofIndex` /
 *     `validateVNextManifest` validators before a manifest is produced.
 *   - v1 Manifests go to the OLD v1 validator; they are never silently
 *     upgraded to vNext. vNext requires the explicit `version: 2` /
 *     `schema_version: 2` discriminator.
 *   - The seam binds `plan_digest` (immutable projection), `file_digest` /
 *     `section_digest` (from the read-only resolver), and cross-checks
 *     stage / slice / proof_index.slice_id consistency.
 *   - Compile + validate are pure / read-only; failure writes nothing.
 *     `writeVNextManifest` compiles + fully validates first, then atomic-writes
 *     (temp + rename) and never leaves a half-written artifact.
 *
 *     stage / slice / proof_index.slice_id consistency.
 *   - Compile + validate are pure / read-only; failure writes nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  computePlanDigest,
  computeDigest,
  validateVNextManifest,
  validateVNextPlan,
  validateVNextReferenceIndex,
  validateVNextProofIndex,
  type VNextCanonicalPlan,
  type VNextManifest,
  type VNextManifestSlice,
  type VNextProofIndex,
  type VNextReferenceIndex,
  type VNextReferenceKind,
  type VNextTaskScope,
} from '@proofloop/kernel';
import { resolveVNextReference } from './entity-resolver';
import { canonicalPathWithinRoot } from '../path-guard';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from './stage-id';

// ============================================================
// Seed input types (structured, additive — never inferred from Markdown)
// ============================================================

/** A single reference the compiler registers into `reference_index`. */
export interface VNextReferenceSeed {
  readonly ref_id: string;
  /** Declared (intended) reference kind; must match the resolved entity kind. */
  readonly kind: VNextReferenceKind;
  /** Canonical entity ref: `<root-relative-path>#/entities/<id>`. */
  readonly ref: string;
}

export interface VNextSliceSeed {
  readonly slice_id: string;
  readonly proof_index: VNextProofIndex;
  readonly required_skills: string[];
  readonly depends_on: string[];
  readonly evidence_path: string;
}

export interface CompileVNextManifestInput {
  /** Trust root for root-relative path resolution. */
  readonly root: string;
  readonly stage_id: string;
  /** Structured vNext Canonical Plan. */
  readonly plan: VNextCanonicalPlan;
  /** Root-relative path of the plan file. */
  readonly plan_path: string;
  readonly refs: VNextReferenceSeed[];
  readonly slices?: VNextSliceSeed[];
  readonly authority_ref_ids?: string[];
  readonly compiled_by?: string;
}

export interface CompileVNextManifestResult {
  readonly manifest: VNextManifest;
  /** Deterministic digest over the immutable plan projection. */
  readonly plan_digest: string;
  /** ref_id → resolved file digest. */
  readonly file_digests: Record<string, string>;
  /** ref_id → resolved section digest. */
  readonly section_digests: Record<string, string>;
}

// ============================================================
// Error surface
// ============================================================

/** Structured compile failure. Every condition fails closed — nothing is emitted. */
export class VNextCompileError extends Error {
  public readonly code:
    | 'invalid-plan'
    | 'invalid-refs'
    | 'invalid-slice'
    | 'invalid-manifest'
    | 'path-escape'
    | 'unexpected';
  constructor(code: VNextCompileError['code'], message: string) {
    super(message);
    this.name = 'VNextCompileError';
    this.code = code;
  }
}

// ============================================================
// Compiler
// ============================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entityId(ref: string): string | undefined {
  const match = /#\/entities\/([^/]+)$/.exec(ref);
  return match?.[1];
}

function cloneExecutionScope(
  scope: NonNullable<VNextCanonicalPlan['items'][number]['execution_scope']>,
): NonNullable<VNextTaskScope['execution_scope']> {
  return {
    kind: scope.kind,
    code_paths: [...scope.code_paths],
    test_paths: [...scope.test_paths],
    forbidden_paths: [...scope.forbidden_paths],
  };
}

function buildSlice(seed: VNextSliceSeed, stageId: string): VNextManifestSlice {
  if (!isRecord(seed)) {
    throw new VNextCompileError('invalid-slice', 'Each slice seed must be an object');
  }

  const sliceId = seed.slice_id;
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new VNextCompileError('invalid-slice', 'slice.slice_id must be a non-empty string');
  }
  if (!sliceId.startsWith(`${stageId}-`)) {
    throw new VNextCompileError(
      'invalid-slice',
      `slice_id "${sliceId}" must be prefixed by stage_id "${stageId}-"`,
    );
  }

  const proofIndex = seed.proof_index;
  if (!isRecord(proofIndex)) {
    throw new VNextCompileError('invalid-slice', 'slice.proof_index must be an object');
  }
  if (proofIndex.slice_id !== sliceId) {
    throw new VNextCompileError(
      'invalid-slice',
      `slice.proof_index.slice_id ("${String(proofIndex.slice_id)}") must equal slice.slice_id ("${sliceId}")`,
    );
  }

  if (!Array.isArray(seed.required_skills)) {
    throw new VNextCompileError('invalid-slice', 'slice.required_skills must be an array');
  }
  if (!Array.isArray(seed.depends_on)) {
    throw new VNextCompileError('invalid-slice', 'slice.depends_on must be an array');
  }

  return {
    slice_id: sliceId,
    proof_index: proofIndex as unknown as VNextProofIndex,
    required_skills: [...seed.required_skills],
    depends_on: [...seed.depends_on],
    evidence_path: seed.evidence_path as string,
  };
}

/**
 * Compile a validated vNext manifest from structured input.
 *
 * Every input is driven through the kernel validators; nothing is inferred
 * from arbitrary Markdown. Pure function — never writes to disk.
 *
 * @throws {VNextCompileError} (wrapping kernel `SchemaValidationError` /
 *         `VNextEntityResolutionError`) on any failure.
 */
export function compileVNextManifest(
  input: CompileVNextManifestInput,
): CompileVNextManifestResult {
  if (!isRecord(input)) {
    throw new VNextCompileError('invalid-plan', 'Compiler input must be an object');
  }
  if (!Array.isArray(input.refs)) {
    throw new VNextCompileError('invalid-refs', 'refs must be an array');
  }
  if (!Array.isArray(input.slices)) {
    throw new VNextCompileError('invalid-slice', 'slices must be an array');
  }
  if (input.slices.length === 0) {
    throw new VNextCompileError('invalid-slice', 'slices must contain at least one slice');
  }

  if (typeof input.root !== 'string' || input.root.length === 0) {
    throw new VNextCompileError('invalid-plan', 'root must be a non-empty string');
  }
  if (typeof input.stage_id !== 'string' || input.stage_id.length === 0) {
    throw new VNextCompileError('invalid-slice', 'stage_id must be a non-empty string');
  }
  // S09-C-T03: canonical Stage ID grammar — the SAME `^S\d+$` rule as the
  // candidate parser, Mechanical Validator, plan/stage/review status and
  // every admission seam.  Legacy parked labels (S08B0/S08B) fail closed
  // here, before any Manifest or plan path is derived.
  if (!CANONICAL_STAGE_ID_RE.test(input.stage_id)) {
    throw new VNextCompileError(
      'invalid-slice',
      `stage_id "${input.stage_id}" is not a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`,
    );
  }
  if (typeof input.plan_path !== 'string' || input.plan_path.length === 0) {
    throw new VNextCompileError('invalid-plan', 'plan_path must be a non-empty root-relative string');
  }

  // 1. Validate the structured plan and bind plan_digest from the immutable
  //    projection (checkbox / status / cv_status excluded by design).
  let plan: VNextCanonicalPlan;
  try {
    plan = validateVNextPlan(input.plan);
  } catch (err) {
    throw new VNextCompileError(
      'invalid-plan',
      `Plan is not vNext-valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const plan_digest = computePlanDigest(plan);

  // 2. Resolve & register every reference through the read-only seam.
  const reference_index: VNextReferenceIndex = {};
  const file_digests: Record<string, string> = {};
  const section_digests: Record<string, string> = {};
  const seenRefIds = new Set<string>();
  for (const seed of input.refs) {
    if (!isRecord(seed)) {
      throw new VNextCompileError('invalid-refs', 'Each ref seed must be an object');
    }
    const refId = seed.ref_id;
    if (typeof refId !== 'string' || refId.length === 0) {
      throw new VNextCompileError('invalid-refs', 'Each ref seed needs a non-empty ref_id');
    }
    if (seenRefIds.has(refId)) {
      throw new VNextCompileError('invalid-refs', `Duplicate ref_id "${refId}" in refs`);
    }
    seenRefIds.add(refId);

    if (typeof seed.kind !== 'string') {
      throw new VNextCompileError('invalid-refs', `Ref "${refId}" needs a string kind`);
    }

    let resolved;
    try {
      resolved = resolveVNextReference({
        root: input.root,
        ref: seed.ref as string,
        expectedKind: seed.kind,
      });
    } catch (err) {
      throw new VNextCompileError(
        'invalid-refs',
        `Ref "${refId}" could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    reference_index[refId] = {
      kind: resolved.kind as VNextReferenceKind,
      ref: resolved.ref,
      file_digest: resolved.fileDigest,
      section_digest: resolved.sectionDigest,
    };
    file_digests[refId] = resolved.fileDigest;
    section_digests[refId] = resolved.sectionDigest;
  }

  // 3. Let the kernel validate the resolved reference index.
  try {
    validateVNextReferenceIndex(reference_index);
  } catch (err) {
    throw new VNextCompileError(
      'invalid-refs',
      `Resolved reference_index is not vNext-valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Materialize scope bindings from the already validated Plan task nodes and
  // their registered task entity refs. Keeping this on the Manifest (rather
  // than only in candidate input) makes the dispatch consumer independently
  // verify the task id/ref binding.
  const task_scopes: Record<string, VNextTaskScope> = {};
  for (const item of plan.items) {
    if (item.kind !== 'task') continue;
    const scope = item.execution_scope;
    if (scope === undefined) {
      throw new VNextCompileError(
        'invalid-plan',
        `Task "${item.id}" has no execution_scope; Runtime will not infer one from Evidence or goal text`,
      );
    }
    const taskRefMatches = item.refs
      .map((refId) => reference_index[refId])
      .filter((descriptor) => descriptor?.kind === 'task' && entityId(descriptor.ref) === item.id);
    if (taskRefMatches.length !== 1) {
      throw new VNextCompileError(
        'invalid-plan',
        `Task "${item.id}" must bind exactly one task entity reference in its Plan refs`,
      );
    }
    task_scopes[item.id] = {
      task_ref: taskRefMatches[0].ref,
      execution_scope: cloneExecutionScope(scope),
    };
  }

  // 4. Build the manifest and run the full kernel validator (single seam).
  const manifest: VNextManifest = {
    version: 2,
    stage_id: input.stage_id,
    plan: {
      ref: input.plan_path,
      plan_digest,
      schema_version: 2,
    },
    reference_index,
    authority_ref_ids: input.authority_ref_ids,
    task_scopes,
    slices: input.slices.map((seed) => buildSlice(seed, input.stage_id)),
    compiled_by: input.compiled_by,
  };

  try {
    validateVNextManifest(manifest);
  } catch (err) {
    throw new VNextCompileError(
      'invalid-manifest',
      `vNext Manifest failed validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    manifest,
    plan_digest,
    file_digests,
    section_digests,
  };
}

// ============================================================
// Atomic write helper (compile + FULL validate, then rename)
// ============================================================

/**
 * Filesystem operations used after compile/validation. The optional seam is
 * deliberately limited to the temp write/rename/cleanup boundary so failure
 * handling can be tested without mutating the process-wide `node:fs` module.
 */
export interface VNextManifestWriteOps {
  readonly writeTemp: (tempPath: string, payload: string) => void;
  readonly renameTemp: (tempPath: string, targetPath: string) => void;
  readonly removeTemp: (tempPath: string) => void;
}

const DEFAULT_WRITE_OPS: VNextManifestWriteOps = {
  writeTemp: (tempPath, payload) => {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow;
    let fd: number | undefined;
    try {
      // Open and write through the same exclusive descriptor. In particular, do
      // not reopen the path after creation: a path replacement cannot redirect
      // the bytes to a symlink or hardlink between open and write.
      fd = fs.openSync(tempPath, flags, 0o600);
      fs.writeFileSync(fd, payload, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  },
  renameTemp: (tempPath, targetPath) => fs.renameSync(tempPath, targetPath),
  removeTemp: (tempPath) => fs.unlinkSync(tempPath),
};

function makeUnpredictableTempPath(dir: string, targetPath: string): string {
  return path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
  );
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compile (and fully validate) a vNext manifest, then atomic-write it to a
 * root-bound `targetPath`. The target is only written AFTER successful
 * compile + validation, via a temp file + rename — a failed compile writes
 * nothing, and a crash mid-write never leaves a half-written artifact.
 *
 * @throws {VNextCompileError} / {VNextEntityResolutionError} on failure
 *         (the target is left untouched).
 */
export function writeVNextManifest(
  input: CompileVNextManifestInput,
  targetPath: string,
  writeOps: VNextManifestWriteOps = DEFAULT_WRITE_OPS,
): CompileVNextManifestResult {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new VNextCompileError('path-escape', 'target path must be a non-empty string');
  }
  if (!isRecord(input) || typeof input.root !== 'string' || input.root.length === 0) {
    throw new VNextCompileError('path-escape', 'root must be a non-empty string');
  }
  const canonical = canonicalPathWithinRoot(input.root, targetPath);
  if (canonical === null) {
    throw new VNextCompileError('path-escape', `target path "${targetPath}" escapes the project root`);
  }
  // The target identity is part of the write boundary, not only its final
  // physical location.  Reject an in-root symlink redirect as well as an
  // outside escape; otherwise a target swapped during compile could publish a
  // valid Manifest at a different inode/path than the caller selected.
  const lexical = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(input.root, targetPath);
  if (canonical !== lexical) {
    throw new VNextCompileError(
      'path-escape',
      `target path "${targetPath}" traverses a symlink or changed identity`,
    );
  }

  // Compile + validate BEFORE touching the target.
  const result = compileVNextManifest(input);

  let payload: string;
  try {
    payload = JSON.stringify(result.manifest, null, 2);
  } catch (err) {
    throw new VNextCompileError(
      'invalid-manifest',
      `vNext Manifest could not be serialized: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const dir = path.dirname(canonical);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = makeUnpredictableTempPath(dir, canonical);
  let writeError: unknown;
  let writeFailed = false;
  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    // The target is not touched until the complete payload has been written
    // to the sibling temp file. A failure in either operation therefore
    // leaves an existing target unchanged.
    writeOps.writeTemp(tmp, payload);
    writeOps.renameTemp(tmp, canonical);
  } catch (error) {
    writeFailed = true;
    writeError = error;
  }

  // `renameSync` removes the temp path on success. On a partial write or a
  // failed rename, remove it explicitly so failed attempts never leave a
  // misleading artifact behind. ENOENT is the only benign cleanup failure:
  // it means the rename (or a failed operation) already removed the path.
  try {
    writeOps.removeTemp(tmp);
  } catch (error) {
    if (!isMissingPathError(error)) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  if (writeFailed && cleanupFailed) {
    throw new AggregateError(
      [writeError, cleanupError],
      `${describeError(writeError)}; temp cleanup failed: ${describeError(cleanupError)}`,
    );
  }
  if (writeFailed) {
    throw writeError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }
  return result;
}

// Keep the import referenced for API documentation symmetry; the real
// validator re-export lives in index.ts (single import path).
// Re-export the kernel's vNext validators so runtime consumers have one
// import path (§ single-validation-seam convention used across the package).
export {
  validateVNextManifest,
  validateVNextReferenceIndex,
  validateVNextProofIndex,
};
