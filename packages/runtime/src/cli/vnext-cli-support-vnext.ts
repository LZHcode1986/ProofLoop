/**
 * Shared support for the explicit vNext Planner CLI seams.
 *
 * This module intentionally contains no Markdown parser and no v1 contract
 * imports.  It provides only root-bound filesystem helpers, bounded error
 * values, and the additional cross-file checks that the kernel cannot perform
 * without knowing the caller's trust root.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  validateVNextManifest,
  type VNextManifest,
  type VNextManifestSlice,
} from '@proofloop/kernel';
import {
  canonicalPathWithinRoot,
} from '../path-guard';
import {
  parseEntityRef,
  readRootBoundFile,
  resolveVNextReference,
} from '../vnext';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE, isCanonicalStageId } from '../vnext/stage-id';

export { readRootBoundFile } from '../vnext';

// ============================================================
// Bounded error surface
// ============================================================

export interface VNextCliError {
  readonly type: string;
  readonly message: string;
  readonly path?: string;
  readonly slice_id?: string;
}

export function vnextError(
  type: string,
  message: string,
  details: { readonly path?: string; readonly slice_id?: string } = {},
): VNextCliError {
  return { type, message, ...details };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================
// Trust-root and path binding
// ============================================================

/**
 * Resolve a project root to its physical directory.  A root that is not an
 * existing directory is never accepted as a trust boundary.
 */
export function resolveProjectRoot(projectRoot?: string): string {
  if (projectRoot !== undefined && (typeof projectRoot !== 'string' || projectRoot.length === 0)) {
    throw new Error('project-root must be a non-empty path');
  }
  const lexical = path.resolve(projectRoot ?? process.cwd());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lexical);
  } catch (error) {
    throw new Error(`project root is not readable: ${lexical} (${errorMessage(error)})`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`project root is not a directory: ${lexical}`);
  }
  const canonical = fs.realpathSync(lexical);
  return canonical;
}

export function assertSameProjectRoot(expected: string, actual: string): void {
  const expectedRoot = resolveProjectRoot(expected);
  const actualRoot = resolveProjectRoot(actual);
  if (expectedRoot !== actualRoot) {
    throw new Error(
      `project root mismatch: input root resolves to "${actualRoot}", ` +
        `but the asserted project root is "${expectedRoot}"`,
    );
  }
}

function slash(value: string): string {
  return value.split(path.sep).join('/');
}

function rootRelativeFromCanonical(root: string, canonical: string): string {
  const canonicalRoot = resolveProjectRoot(root);
  const relative = path.relative(canonicalRoot, canonical);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`path "${canonical}" is outside project root "${canonicalRoot}"`);
  }
  return slash(relative);
}

/**
 * Validate a manifest/reference path that is required to be canonical and
 * root-relative.  `.` / `..`, absolute paths, and symlink-normalized paths are
 * rejected instead of being silently normalized.
 */
export function assertRootRelativePath(
  root: string,
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty root-relative path`);
  }
  if (value.includes('\u0000') || value.includes('\\') || path.isAbsolute(value)) {
    throw new Error(`${field} must be a canonical root-relative path: "${value}"`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`${field} contains a non-canonical path component: "${value}"`);
  }

  const canonical = canonicalPathWithinRoot(root, value);
  if (canonical === null) {
    throw new Error(`${field} escapes the project root: "${value}"`);
  }
  const canonicalRelative = rootRelativeFromCanonical(root, canonical);
  if (canonicalRelative !== value) {
    throw new Error(
      `${field} is not bound to its canonical root-relative path: ` +
        `"${value}" resolves as "${canonicalRelative}"`,
    );
  }
  return canonicalRelative;
}

/** Resolve a CLI path while retaining the physical root-bound target. */
export function resolveRootBoundPath(root: string, value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty path`);
  }
  const canonical = canonicalPathWithinRoot(root, value);
  if (canonical === null) {
    throw new Error(`${field} escapes the project root: "${value}"`);
  }
  return canonical;
}

/** Root-relative path of a CLI argument after its root-bound read. */
export function rootRelativeCliPath(root: string, value: string, field: string): string {
  const canonical = resolveRootBoundPath(root, value, field);
  return rootRelativeFromCanonical(root, canonical);
}

export function stageIdFromArtifactPath(value: string): string | undefined {
  const match = /^delivery\/stages\/([^/]+)\/(?:tasks\.md|evidence(?:\/|$))/.exec(value);
  return match?.[1];
}

/**
 * S09-C-T03: a stage segment extracted from an artifact path must itself be a
 * canonical Stage ID.  A parked legacy label (S08B0/S08B) in any Runtime
 * artifact path fails closed before the path is used for read/write.
 */
export function stageSegmentError(value: string, field: string, pathValue: string): VNextCliError | null {
  const stage = stageIdFromArtifactPath(value);
  if (stage !== undefined && !isCanonicalStageId(stage)) {
    return vnextError(
      'STAGE_ID_INVALID',
      `${field} contains a non-canonical Stage ID "${stage}" (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`,
      { path: pathValue },
    );
  }
  return null;
}

export function readRootBoundJson(
  root: string,
  filePath: string,
  label: string,
): { readonly value: unknown; readonly filePath: string } {
  const read = readRootBoundFile(root, filePath);
  let value: unknown;
  try {
    value = JSON.parse(read.content) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
  return { value, filePath: read.filePath };
}

/**
 * Read a JSON request when the request itself carries the trust root.  The
 * first parse only discovers the candidate root; the request is then read
 * again through the no-follow, TOCTOU-checked root-bound reader.
 */
export function readJsonWithEmbeddedRoot(
  filePath: string,
  assertedProjectRoot?: string,
): { readonly root: string; readonly value: unknown; readonly filePath: string } {
  const embeddedRoot = (value: unknown): unknown => {
    if (!isRecord(value)) return undefined;
    // The original structured compiler input uses `root`; the active
    // pluginv2 candidate-input contract uses `project_root`.  Both are
    // discovery-only fields and are checked against the canonical trust root
    // before the input is consumed.
    return value.root ?? value.project_root;
  };
  if (assertedProjectRoot !== undefined) {
    // When the caller supplies the trust root, do not perform an initial
    // symlink-following discovery read.  The request is read only through the
    // asserted root boundary, then its embedded root is checked for equality.
    const assertedRoot = resolveProjectRoot(assertedProjectRoot);
    const read = readRootBoundJson(assertedRoot, filePath, 'structured input');
    const embedded = embeddedRoot(read.value);
    if (typeof embedded !== 'string' || embedded.length === 0) {
      throw new Error('structured input must carry a non-empty root field');
    }
    assertSameProjectRoot(assertedRoot, embedded);
    return { root: assertedRoot, value: read.value, filePath: read.filePath };
  }

  let initialText: string;
  try {
    initialText = fs.readFileSync(path.resolve(filePath), 'utf-8');
  } catch (error) {
    throw new Error(`structured input cannot be read: ${errorMessage(error)}`);
  }
  let initial: unknown;
  try {
    initial = JSON.parse(initialText) as unknown;
  } catch (error) {
    throw new Error(`structured input is not valid JSON: ${errorMessage(error)}`);
  }
  const embedded = embeddedRoot(initial);
  if (typeof embedded !== 'string' || embedded.length === 0) {
    throw new Error('structured input must carry a non-empty root field');
  }

  const resolvedEmbeddedRoot = resolveProjectRoot(embedded);
  const read = readRootBoundJson(resolvedEmbeddedRoot, filePath, 'structured input');
  return { root: resolvedEmbeddedRoot, value: read.value, filePath: read.filePath };
}

// ============================================================
// vNext Manifest cross-file validation
// ============================================================

export interface VNextManifestValidationOptions {
  readonly tasksPath?: string;
  readonly evidenceDir?: string;
  readonly verifyReferenceDigests?: boolean;
  /**
   * S09-D-T01 — final all-binding Validator.  When true, every declared
   * Evidence file must parse a Plan Binding header that exactly matches the
   * Manifest (stage/slice/plan ref/plan digest/manifest digest) and no
   * unrecovered refresh journal may be present.  Mixed bindings (a file still
   * on the previous Manifest digest next to a file on the current one) fail
   * closed and cannot reach SPV/admission.
   */
  readonly verifyEvidenceBindings?: boolean;
}

/** S09-D-T01 — journal file name inside the verified evidence directory. */
export const REFRESH_JOURNAL_FILE = '.vnext-refresh-journal.json';

export interface VNextManifestValidationResult {
  readonly manifest: VNextManifest | null;
  readonly stage_id: string;
  readonly errors: readonly VNextCliError[];
}

function checkUniqueManifestPaths(
  root: string,
  manifest: VNextManifest,
  errors: VNextCliError[],
): Map<string, string> {
  const seenSlices = new Map<string, string>();
  const seenEvidence = new Map<string, string>();
  const evidenceAbsBySlice = new Map<string, string>();

  for (const slice of manifest.slices) {
    if (seenSlices.has(slice.slice_id)) {
      errors.push(
        vnextError(
          'DUPLICATE_SLICE_ID',
          `Manifest contains duplicate slice_id "${slice.slice_id}"`,
          { slice_id: slice.slice_id },
        ),
      );
    } else {
      seenSlices.set(slice.slice_id, slice.slice_id);
    }

    if (!slice.slice_id.startsWith(`${manifest.stage_id}-`)) {
      errors.push(
        vnextError(
          'STAGE_ID_MISMATCH',
          `slice_id "${slice.slice_id}" is not prefixed by stage_id "${manifest.stage_id}-"`,
          { slice_id: slice.slice_id },
        ),
      );
    }

    try {
      const relative = assertRootRelativePath(
        root,
        slice.evidence_path,
        `manifest.slices[${slice.slice_id}].evidence_path`,
      );
      const absolute = resolveRootBoundPath(root, relative, 'manifest evidence_path');
      evidenceAbsBySlice.set(slice.slice_id, absolute);
      if (seenEvidence.has(relative)) {
        errors.push(
          vnextError(
            'DUPLICATE_EVIDENCE_PATH',
            `Manifest contains duplicate evidence_path "${relative}"`,
            { path: relative, slice_id: slice.slice_id },
          ),
        );
      } else {
        seenEvidence.set(relative, slice.slice_id);
      }

      const pathStage = stageIdFromArtifactPath(relative);
      const pathStageError = stageSegmentError(relative, 'evidence_path stage', relative);
      if (pathStageError !== null) {
        errors.push(pathStageError);
      } else if (pathStage !== undefined && pathStage !== manifest.stage_id) {
        errors.push(
          vnextError(
            'STAGE_ID_MISMATCH',
            `evidence_path stage "${pathStage}" does not match manifest stage_id "${manifest.stage_id}"`,
            { path: relative, slice_id: slice.slice_id },
          ),
        );
      }
    } catch (error) {
      errors.push(
        vnextError(
          'PATH_ESCAPE',
          `manifest.slices[${slice.slice_id}].evidence_path: ${errorMessage(error)}`,
          { path: String(slice.evidence_path), slice_id: slice.slice_id },
        ),
      );
    }
  }

  return evidenceAbsBySlice;
}

function checkReferenceBindings(
  root: string,
  manifest: VNextManifest,
  errors: VNextCliError[],
): void {
  for (const [refId, descriptor] of Object.entries(manifest.reference_index)) {
    let parsed: ReturnType<typeof parseEntityRef>;
    try {
      parsed = parseEntityRef(descriptor.ref);
      const relative = assertRootRelativePath(
        root,
        parsed.path,
        `manifest.reference_index.${refId}.ref path`,
      );
      const expectedRef = `${relative}#/entities/${parsed.entityId}`;
      if (descriptor.ref !== expectedRef) {
        errors.push(
          vnextError(
            'PATH_MISMATCH',
            `reference ${refId} is not bound to its canonical ref "${expectedRef}"`,
            { path: descriptor.ref },
          ),
        );
      }
    } catch (error) {
      errors.push(
        vnextError(
          'REF_INVALID',
          `reference ${refId} is not a root-bound vNext entity ref: ${errorMessage(error)}`,
          { path: descriptor.ref },
        ),
      );
      continue;
    }

    try {
      const resolved = resolveVNextReference({
        root,
        ref: descriptor.ref,
        expectedKind: descriptor.kind,
      });
      if (resolved.ref !== descriptor.ref) {
        errors.push(
          vnextError(
            'REF_MISMATCH',
            `reference ${refId} resolved to "${resolved.ref}", not "${descriptor.ref}"`,
            { path: descriptor.ref },
          ),
        );
      }
      if (resolved.fileDigest !== descriptor.file_digest) {
        errors.push(
          vnextError(
            'FILE_DIGEST_MISMATCH',
            `reference ${refId} file_digest does not match the root-bound source`,
            { path: descriptor.ref },
          ),
        );
      }
      if (resolved.sectionDigest !== descriptor.section_digest) {
        errors.push(
          vnextError(
            'SECTION_DIGEST_MISMATCH',
            `reference ${refId} section_digest does not match the root-bound entity`,
            { path: descriptor.ref },
          ),
        );
      }
    } catch (error) {
      errors.push(
        vnextError(
          'REF_RESOLUTION_FAILED',
          `reference ${refId} could not be re-resolved: ${errorMessage(error)}`,
          { path: descriptor.ref },
        ),
      );
    }
  }
}

function checkEvidenceDirectoryBinding(
  root: string,
  manifest: VNextManifest,
  evidenceAbsBySlice: ReadonlyMap<string, string>,
  evidenceDir: string,
  errors: VNextCliError[],
): void {
  let canonicalDir: string;
  try {
    canonicalDir = resolveExistingDirectory(root, evidenceDir, 'evidence-dir');
  } catch (error) {
    errors.push(vnextError('EVIDENCE_DIR_ERROR', errorMessage(error), { path: evidenceDir }));
    return;
  }

  const expected = new Map<string, string>();
  for (const slice of manifest.slices) {
    const evidencePath = evidenceAbsBySlice.get(slice.slice_id);
    if (evidencePath === undefined) continue;
    if (path.dirname(evidencePath) !== canonicalDir) {
      errors.push(
        vnextError(
          'EVIDENCE_PATH_OUT_OF_DIR',
          `slice evidence_path resolves outside evidence-dir "${canonicalDir}"`,
          { path: slice.evidence_path, slice_id: slice.slice_id },
        ),
      );
      continue;
    }
    expected.set(path.basename(evidencePath), slice.slice_id);
    try {
      // The read is both an existence check and a final-component no-follow /
      // post-read TOCTOU check.  Its content is intentionally not parsed.
      readRootBoundFile(root, evidencePath);
    } catch (error) {
      errors.push(
        vnextError(
          'MISSING_EVIDENCE_FILE',
          `slice evidence file is missing or unreadable: ${errorMessage(error)}`,
          { path: slice.evidence_path, slice_id: slice.slice_id },
        ),
      );
    }
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(canonicalDir, { withFileTypes: true });
  } catch (error) {
    errors.push(vnextError('EVIDENCE_DIR_ERROR', `cannot scan evidence-dir: ${errorMessage(error)}`, { path: canonicalDir }));
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(canonicalDir, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(vnextError('EVIDENCE_SYMLINK', `evidence-dir entry is a symlink: "${entry.name}"`, { path: entryPath }));
      continue;
    }
    if (!entry.isFile()) {
      errors.push(vnextError('ORPHANED_EVIDENCE', `evidence-dir entry is not a regular evidence file: "${entry.name}"`, { path: entryPath }));
      continue;
    }
    if (!expected.has(entry.name)) {
      errors.push(vnextError('ORPHANED_EVIDENCE', `evidence file has no declared slice: "${entry.name}"`, { path: entryPath }));
    }
  }
}

/**
 * S09-D-T01 — final all-binding Validator.
 *
 * Every declared Evidence file must carry a Plan Binding header whose Stage
 * ID / Slice ID / Plan Ref / Plan Digest / Manifest Digest all match the
 * Manifest exactly.  A file on any other binding (e.g. the previous Manifest
 * digest after a replan) makes the whole Stage invalid — mixed bindings can
 * never reach SPV/admission.  An unrecovered refresh journal (left by an
 * interrupted refresh transaction) also blocks final validation until the
 * transaction is recovered or rolled back.
 */
function checkEvidenceBindings(
  root: string,
  manifest: VNextManifest,
  evidenceAbsBySlice: ReadonlyMap<string, string>,
  errors: VNextCliError[],
): void {
  const manifestDigest = computeVNextManifestDigest(manifest);
  const journalCheckedDirs = new Set<string>();
  for (const slice of manifest.slices) {
    const evidencePath = evidenceAbsBySlice.get(slice.slice_id);
    if (evidencePath === undefined) continue;

    const directory = path.dirname(evidencePath);
    if (!journalCheckedDirs.has(directory)) {
      journalCheckedDirs.add(directory);
      const journalPath = path.join(directory, REFRESH_JOURNAL_FILE);
      if (canonicalPathWithinRoot(root, journalPath) !== null) {
        try {
          fs.lstatSync(journalPath);
          errors.push(
            vnextError(
              'UNRECOVERED_TRANSACTION',
              'an unrecovered Evidence refresh journal blocks final validation until recover/rollback',
              { path: journalPath },
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            errors.push(
              vnextError('UNRECOVERED_TRANSACTION', `cannot inspect refresh journal: ${errorMessage(error)}`, {
                path: journalPath,
              }),
            );
          }
        }
      }
    }

    let content: string;
    try {
      content = readRootBoundFile(root, evidencePath).content;
    } catch (error) {
      errors.push(
        vnextError(
          'EVIDENCE_BINDING_MISMATCH',
          `evidence cannot be read for binding validation: ${errorMessage(error)}`,
          { path: slice.evidence_path, slice_id: slice.slice_id },
        ),
      );
      continue;
    }
    const binding = parseEvidencePlanBinding(content);
    if (binding === null) {
      errors.push(
        vnextError('EVIDENCE_BINDING_MISMATCH', 'evidence file has no parseable Plan Binding header', {
          path: slice.evidence_path,
          slice_id: slice.slice_id,
        }),
      );
      continue;
    }
    const mismatches: string[] = [];
    if (binding.stage_id !== manifest.stage_id) mismatches.push(`Stage ID "${binding.stage_id}"`);
    if (binding.slice_id !== slice.slice_id) mismatches.push(`Slice ID "${binding.slice_id}"`);
    if (binding.plan_ref !== manifest.plan.ref) mismatches.push(`Plan Ref "${binding.plan_ref}"`);
    if (binding.plan_digest !== manifest.plan.plan_digest) mismatches.push('Plan Digest');
    if (binding.manifest_digest !== manifestDigest) mismatches.push('Manifest Digest');
    if (mismatches.length > 0) {
      errors.push(
        vnextError(
          'EVIDENCE_BINDING_MISMATCH',
          `evidence binding does not match the Manifest (${mismatches.join(', ')})`,
          { path: slice.evidence_path, slice_id: slice.slice_id },
        ),
      );
    }
  }
}

/**
 * Kernel validation plus root/path/digest checks shared by validate and
 * initialize.  It never writes and never interprets a tasks.md body.
 */
export function validateVNextManifestArtifact(
  root: string,
  value: unknown,
  options: VNextManifestValidationOptions = {},
): VNextManifestValidationResult {
  const errors: VNextCliError[] = [];
  let manifest: VNextManifest | null = null;
  let stageId = 'unknown';

  try {
    manifest = validateVNextManifest(value);
    stageId = manifest.stage_id;
  } catch (error) {
    if (isRecord(value) && typeof value.stage_id === 'string' && value.stage_id.length > 0) {
      stageId = value.stage_id;
    }
    errors.push(vnextError('SCHEMA_INVALID', `Manifest is not vNext schema_version 2: ${errorMessage(error)}`));
    return { manifest: null, stage_id: stageId, errors };
  }

  // S09-C-T03: the Mechanical Validator applies the SAME canonical Stage ID
  // grammar (`^S\d+$`) as the candidate parser, compiler, plan/stage/review
  // status and every admission seam.  A schema-valid Manifest whose stage_id
  // is a parked legacy label (S08B0/S08B) fails closed before any further
  // path/digest read — it can never name a Runtime artifact.
  if (!isCanonicalStageId(manifest.stage_id)) {
    errors.push(
      vnextError(
        'STAGE_ID_INVALID',
        `Manifest stage_id "${manifest.stage_id}" is not a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`,
      ),
    );
    return { manifest, stage_id: manifest.stage_id, errors };
  }

  try {
    assertRootRelativePath(root, manifest.plan.ref, 'manifest.plan.ref');
  } catch (error) {
    errors.push(vnextError('PATH_ESCAPE', `manifest.plan.ref: ${errorMessage(error)}`, { path: manifest.plan.ref }));
  }

  const evidenceAbsBySlice = checkUniqueManifestPaths(root, manifest, errors);

  const taskPathStage = stageIdFromArtifactPath(manifest.plan.ref);
  const planPathStageError = stageSegmentError(manifest.plan.ref, 'manifest.plan.ref stage', manifest.plan.ref);
  if (planPathStageError !== null) {
    errors.push(planPathStageError);
  } else if (taskPathStage !== undefined && taskPathStage !== manifest.stage_id) {
    errors.push(
      vnextError(
        'STAGE_ID_MISMATCH',
        `manifest.plan.ref stage "${taskPathStage}" does not match manifest stage_id "${manifest.stage_id}"`,
        { path: manifest.plan.ref },
      ),
    );
  }

  for (const [index, slice] of manifest.slices.entries()) {
    // The kernel checks the proof-index shape and ref registration.  This
    // additional assertion keeps the owner binding explicit even when a
    // future kernel validator accepts a broader slice-id grammar.
    if (slice.proof_index.slice_id !== slice.slice_id) {
      errors.push(
        vnextError(
          'SLICE_ID_MISMATCH',
          `manifest.slices[${index}].proof_index.slice_id must equal slice_id`,
          { slice_id: slice.slice_id },
        ),
      );
    }
  }

  if (options.tasksPath !== undefined) {
    try {
      const tasksRelative = rootRelativeCliPath(root, options.tasksPath, 'tasks.md');
      if (tasksRelative !== manifest.plan.ref) {
        errors.push(
          vnextError(
            'PLAN_REF_MISMATCH',
            `manifest.plan.ref "${manifest.plan.ref}" does not equal root-relative tasks path "${tasksRelative}"`,
            { path: manifest.plan.ref },
          ),
        );
      }
      const actualTaskStage = stageIdFromArtifactPath(tasksRelative);
      const tasksPathStageError = stageSegmentError(tasksRelative, 'tasks.md path stage', tasksRelative);
      if (tasksPathStageError !== null) {
        errors.push(tasksPathStageError);
      } else if (actualTaskStage !== undefined && actualTaskStage !== manifest.stage_id) {
        errors.push(
          vnextError(
            'STAGE_ID_MISMATCH',
            `tasks.md path stage "${actualTaskStage}" does not match manifest stage_id "${manifest.stage_id}"`,
            { path: tasksRelative },
          ),
        );
      }
    } catch (error) {
      errors.push(vnextError('PATH_ESCAPE', `tasks.md: ${errorMessage(error)}`, { path: options.tasksPath }));
    }
  }

  if (options.evidenceDir !== undefined) {
    checkEvidenceDirectoryBinding(root, manifest, evidenceAbsBySlice, options.evidenceDir, errors);
    try {
      const relativeDir = rootRelativeCliPath(root, options.evidenceDir, 'evidence-dir');
      const evidenceStage = stageIdFromArtifactPath(`${relativeDir}/evidence/`);
      const evidenceDirStageError = stageSegmentError(`${relativeDir}/evidence/`, 'evidence-dir stage', relativeDir);
      if (evidenceDirStageError !== null) {
        errors.push(evidenceDirStageError);
      } else if (evidenceStage !== undefined && evidenceStage !== manifest.stage_id) {
        errors.push(
          vnextError(
            'STAGE_ID_MISMATCH',
            `evidence-dir stage "${evidenceStage}" does not match manifest stage_id "${manifest.stage_id}"`,
            { path: relativeDir },
          ),
        );
      }
    } catch {
      // `checkEvidenceDirectoryBinding` already reported the bounded path
      // failure.  Avoid producing a duplicate generic error here.
    }
  }

  if (options.verifyEvidenceBindings === true) {
    checkEvidenceBindings(root, manifest, evidenceAbsBySlice, errors);
  }

  if (options.verifyReferenceDigests !== false) {
    checkReferenceBindings(root, manifest, errors);
  }

  return { manifest, stage_id: stageId, errors };
}

// ============================================================
// Root-bound directory and atomic evidence writes
// ============================================================

export interface VerifiedDirectory {
  readonly physicalPath: string;
  readonly dev: number;
  readonly ino: number;
}

/** Resolve an existing directory without accepting symlinked inner components. */
export function resolveExistingDirectory(root: string, directory: string, field: string): string {
  const canonical = resolveRootBoundPath(root, directory, field);
  const lexical = path.isAbsolute(directory) ? path.resolve(directory) : path.resolve(root, directory);
  if (canonical !== lexical) {
    throw new Error(`${field} traverses a symlink; refusing to use "${directory}"`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(canonical);
  } catch (error) {
    throw new Error(`${field} is not readable: ${errorMessage(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${field} is not a regular directory: "${directory}"`);
  }
  return canonical;
}

/**
 * Create/verify a directory chain one component at a time, never following an
 * inner symlink.  Missing directories are the only filesystem objects this
 * helper creates.
 */
export function ensureDirectoryNoFollow(root: string, directory: string): VerifiedDirectory {
  const canonicalRoot = resolveProjectRoot(root);
  const canonicalTarget = resolveRootBoundPath(canonicalRoot, directory, 'evidence-dir');
  const lexicalTarget = path.isAbsolute(directory) ? path.resolve(directory) : path.resolve(canonicalRoot, directory);
  if (canonicalTarget !== lexicalTarget) {
    throw new Error(`evidence-dir traverses a symlink: "${directory}"`);
  }
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`evidence-dir must be a non-root path inside the project root`);
  }

  let current = canonicalRoot;
  for (const component of relative.split(path.sep)) {
    if (component.length === 0) continue;
    const candidate = path.join(current, component);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(`cannot inspect evidence parent "${candidate}": ${errorMessage(error)}`);
      }
      try {
        fs.mkdirSync(candidate);
      } catch (mkdirError) {
        // A concurrent creator may have won the race.  Re-stat it and apply
        // the same no-follow checks; anything else fails closed.
        try {
          stat = fs.lstatSync(candidate);
        } catch {
          throw new Error(`cannot create evidence parent "${candidate}": ${errorMessage(mkdirError)}`);
        }
      }
    }
    if (stat === undefined) {
      stat = fs.lstatSync(candidate);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`evidence parent "${candidate}" is a symlink`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`evidence parent "${candidate}" is not a directory`);
    }
    current = candidate;
  }

  // Re-resolve after the component walk as a final race check.  If a parent
  // was swapped after its lstat, the physical directory must still be the
  // exact canonical target selected before the walk.
  const finalPhysical = fs.realpathSync(current);
  if (finalPhysical !== canonicalTarget) {
    throw new Error('evidence directory changed during no-follow verification');
  }
  const finalStat = fs.statSync(finalPhysical);
  return { physicalPath: finalPhysical, dev: finalStat.dev, ino: finalStat.ino };
}

export interface OpenVerifiedDirectory {
  readonly dirfd: number;
  readonly procPrefix: string;
}

export function openVerifiedDirectory(directory: VerifiedDirectory): OpenVerifiedDirectory {
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const dirfd = fs.openSync(directory.physicalPath, flags);
  try {
    const stat = fs.fstatSync(dirfd);
    if (stat.dev !== directory.dev || stat.ino !== directory.ino || !stat.isDirectory()) {
      throw new Error('evidence directory changed between verification and open');
    }
    return { dirfd, procPrefix: `/proc/self/fd/${dirfd}` };
  } catch (error) {
    try {
      fs.closeSync(dirfd);
    } catch {
      // best effort
    }
    throw error;
  }
}

export type AtomicEvidenceResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'error'; readonly message: string };

const TEMP_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

function readExistingEvidence(procPath: string): AtomicEvidenceResult | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(procPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { kind: 'error', message: `cannot inspect evidence file: ${errorMessage(error)}` };
  }
  if (stat.isSymbolicLink()) {
    return { kind: 'error', message: 'evidence target is a symlink; refusing to follow it' };
  }
  if (!stat.isFile()) {
    return { kind: 'error', message: 'evidence target is not a regular file' };
  }

  let fd: number;
  try {
    fd = fs.openSync(procPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    return { kind: 'error', message: `cannot open existing evidence file: ${errorMessage(error)}` };
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return { kind: 'error', message: 'evidence target changed to a non-regular file' };
    }
    const bytes = fs.readFileSync(fd);
    return bytes.length > 0 ? { kind: 'skipped' } : { kind: 'error', message: 'existing evidence file is empty; refusing to replace it' };
  } catch (error) {
    return { kind: 'error', message: `cannot read existing evidence file: ${errorMessage(error)}` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // best effort
    }
  }
}

/**
 * Create an evidence file with temp-write + fsync + atomic no-replace hard
 * link.  `linkSync` is used instead of rename so a concurrent target creation
 * cannot be overwritten.  Every failure removes the temp inode and leaves no
 * partially written target.
 */
export function writeAtomicEvidence(
  procPrefix: string,
  fileName: string,
  content: string,
): AtomicEvidenceResult {
  if (fileName.length === 0 || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    return { kind: 'error', message: `invalid evidence file name "${fileName}"` };
  }
  const target = `${procPrefix}/${fileName}`;
  const existing = readExistingEvidence(target);
  if (existing !== null) return existing;

  const tempName = `.${fileName}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const temp = `${procPrefix}/${tempName}`;
  let fd: number | undefined;
  let linked = false;
  try {
    fd = fs.openSync(temp, TEMP_FLAGS, 0o644);
    const bytes = Buffer.from(content, 'utf-8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error('short write while creating evidence skeleton');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    try {
      fs.linkSync(temp, target);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const raced = readExistingEvidence(target);
        return raced ?? { kind: 'error', message: 'evidence target appeared during atomic install' };
      }
      throw error;
    }
    return { kind: 'created' };
  } catch (error) {
    return { kind: 'error', message: `atomic evidence write failed: ${errorMessage(error)}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    if (!linked) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // ENOENT is normal when open failed; cleanup is best effort otherwise.
      }
    } else {
      try {
        fs.unlinkSync(temp);
      } catch {
        // The target is already a complete hard link.  No half-written file is
        // exposed even if cleanup of the temporary directory entry fails.
      }
    }
  }
}

export function computeVNextManifestDigest(manifest: VNextManifest): string {
  return computeDigest(manifest);
}

/**
 * S09-D-T01 — parse the Plan Binding header of a vNext Evidence skeleton.
 *
 * The initializer skeleton (and every refreshed skeleton) carries exactly one
 * `## Plan Binding` section with single-line Stage ID / Slice ID / Plan Ref /
 * Plan Digest / Manifest Digest fields.  This parser is the single binding
 * reader shared by the refresh preflight (old-binding check) and the final
 * all-binding Validator (mixed-binding rejection).  Returns `null` when the
 * section or any required field is absent or DUPLICATED — duplicate binding
 * lines are never trusted (S09-D-T01 repair).
 */
export interface EvidencePlanBinding {
  readonly stage_id: string;
  readonly slice_id: string;
  readonly plan_ref: string;
  readonly plan_digest: string;
  readonly manifest_digest: string;
}

export function parseEvidencePlanBinding(content: string): EvidencePlanBinding | null {
  // Exactly ONE `## Plan Binding` section is allowed: a duplicated section
  // (a second section anywhere in the file) fails closed — the final
  // Validator and the pristine/refresh preflight share this parser, so a
  // forged second section can never bypass the duplicate-field checks.
  const sections = [...content.matchAll(/^## Plan Binding$/gm)];
  if (sections.length !== 1) return null;
  const sectionMatch = sections[0];
  const section = content.slice(sectionMatch.index + sectionMatch[0].length);
  const nextHeader = /^## /m.exec(section);
  const body = nextHeader === null ? section : section.slice(0, nextHeader.index);

  const readField = (label: string): string | null => {
    const pattern = new RegExp(`^\\s*- ${label}: (.+)$`, 'gm');
    const lines = [...body.matchAll(pattern)];
    if (lines.length !== 1) return null; // absent OR duplicated — fail closed
    const value = lines[0][1].trim();
    return value.length === 0 ? null : value;
  };

  const stageId = readField('Stage ID');
  const sliceId = readField('Slice ID');
  const planRef = readField('Plan Ref');
  const planDigest = readField('Plan Digest');
  const manifestDigest = readField('Manifest Digest');
  if (stageId === null || sliceId === null || planRef === null || planDigest === null || manifestDigest === null) {
    return null;
  }
  return { stage_id: stageId, slice_id: sliceId, plan_ref: planRef, plan_digest: planDigest, manifest_digest: manifestDigest };
}

export function renderVNextEvidenceSkeleton(
  manifest: VNextManifest,
  slice: VNextManifestSlice,
  manifestDigest: string,
): string {
  const proof = slice.proof_index;
  const list = (values: readonly string[]): string => (values.length === 0 ? '*None*' : values.join(', '));
  const riskIds = proof.risk_refs.map((risk) => risk.ref_id);
  const authority = manifest.authority_ref_ids ?? [];
  return `# Slice ${slice.slice_id} Evidence (vNext)

## Plan Binding

- Stage ID: ${manifest.stage_id}
- Slice ID: ${slice.slice_id}
- Plan Ref: ${manifest.plan.ref}
- Plan Digest: ${manifest.plan.plan_digest}
- Manifest Digest: ${manifestDigest}

## Proof Index

- Goal Ref ID: ${proof.goal_ref}
- Task Ref IDs: ${list(proof.task_refs)}
- Acceptance Ref IDs: ${list(proof.acceptance_refs)}
- Seam Ref IDs: ${list(proof.seam_refs)}
- Oracle Ref IDs: ${list(proof.oracle_refs)}
- Risk Ref IDs: ${list(riskIds)}

## Authority References

- Ref IDs: ${list(authority)}

## Task Evidence

*Not yet captured.*

## Current Slice Evidence

*Not yet captured.*

## Current CV Status

- Status: NOT_RUN
- Latest CV Receipt: *None*
- Open Finding: *None*
`;
}
