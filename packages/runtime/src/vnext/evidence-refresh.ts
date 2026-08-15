/**
 * S09-D-T01 — Runtime-owned pre-admission pristine Evidence refresh service.
 *
 * After a Manifest digest changes, `initialize` intentionally skips existing
 * non-empty Evidence skeletons, so the ONLY legal rebind path is this explicit
 * refresh transaction.  It is strictly pre-admission: the Stage must have no
 * plan/execution Receipts and every declared Evidence file must still be the
 * initializer's pristine template bound to the expected previous Manifest
 * digest (old binding / root / file identity / receipt absence are fully
 * preflighted BEFORE any write).
 *
 * The update itself is a transaction: a journal file (inside the verified
 * evidence directory) records the old and new content of every declared
 * evidence file, then each file is updated with per-file compare-and-swap
 * (content compare + temp-write + fsync + atomic rename).  Success requires
 * full coverage of every Manifest-declared evidence path.  An in-process
 * write failure rolls the already-swapped files back to the old binding; an
 * interrupted process leaves the journal behind so a fresh refresh FAILS
 * CLOSED with `blocked_recovery` (never silently continues a partial
 * transaction).  `recover` mode completes the journaled transaction and
 * `rollback` mode reverts it — both fail closed when the current file state
 * matches neither the journaled old nor new content.
 *
 * This operation writes no Receipt, changes no checkbox/Task/CV state and is
 * not allowed post-admission.  It is the refresh half of the bootstrap
 * contract (Acceptance B / Seam §5.3 / HP-015 / HP-012).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VNEXT_SCHEMA_VERSION, type VNextManifest } from '@proofloop/kernel';
import { canonicalPathWithinRoot } from '../path-guard';
import {
  computeVNextManifestDigest,
  ensureDirectoryNoFollow,
  errorMessage,
  openVerifiedDirectory,
  readRootBoundJson,
  REFRESH_JOURNAL_FILE,
  renderVNextEvidenceSkeleton,
  resolveProjectRoot,
  resolveRootBoundPath,
  validateVNextManifestArtifact,
  vnextError,
  writeAtomicEvidence,
  parseEvidencePlanBinding,
  type VNextCliError,
} from '../cli/vnext-cli-support-vnext';

export { REFRESH_JOURNAL_FILE } from '../cli/vnext-cli-support-vnext';

export type RefreshVNextMode = 'refresh' | 'recover' | 'rollback';

export interface RefreshVNextSliceEvidenceRequest {
  /** Root-relative (or root-bound) path of the CURRENT compiled vNext Manifest. */
  readonly manifestPath: string;
  /** Expected previous Manifest digest that every skeleton must still bind. */
  readonly previousManifestDigest: string;
  readonly evidenceDir?: string;
  readonly projectRoot?: string;
  readonly mode?: RefreshVNextMode;
}

export interface RefreshVNextSliceEvidenceResult {
  readonly success: boolean;
  readonly stage_id: string;
  readonly schema_version: typeof VNEXT_SCHEMA_VERSION;
  readonly mode: RefreshVNextMode;
  /** Root-relative evidence paths updated by this call. */
  readonly refreshed: readonly string[];
  readonly recovered: boolean;
  readonly rolled_back: boolean;
  /** An unrecovered journal blocks refresh until recover/rollback runs. */
  readonly blocked_recovery: boolean;
  readonly errors: readonly VNextCliError[];
}

interface RefreshJournalFile {
  readonly version: 1;
  readonly stage_id: string;
  readonly manifest_ref: string;
  readonly previous_manifest_digest: string;
  readonly manifest_digest: string;
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly old: string;
    readonly new: string;
    /** dev:ino of the target captured BEFORE the swap (file identity check). */
    readonly old_identity: string;
  }>;
}

interface JournalReadResult {
  readonly kind: 'absent' | 'ok' | 'invalid';
  readonly journal?: RefreshJournalFile;
  readonly message?: string;
}

function isJournalFile(value: unknown): value is RefreshJournalFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (typeof record.stage_id !== 'string' || record.stage_id.length === 0) return false;
  if (typeof record.manifest_ref !== 'string' || record.manifest_ref.length === 0) return false;
  if (
    typeof record.previous_manifest_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.previous_manifest_digest)
  ) {
    return false;
  }
  if (typeof record.manifest_digest !== 'string' || !/^[a-f0-9]{64}$/.test(record.manifest_digest)) {
    return false;
  }
  if (!Array.isArray(record.files) || record.files.length === 0) return false;
  for (const entry of record.files) {
    if (typeof entry !== 'object' || entry === null) return false;
    const file = entry as Record<string, unknown>;
    if (
      typeof file.name !== 'string' ||
      file.name.length === 0 ||
      file.name.includes('/') ||
      file.name.includes('\\') ||
      typeof file.old !== 'string' ||
      typeof file.new !== 'string' ||
      typeof file.old_identity !== 'string' ||
      !/^\d+:\d+$/.test(file.old_identity)
    ) {
      return false;
    }
  }
  return true;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * Compare a skeleton against the current template ignoring the two binding
 * digest lines (`Plan Digest` / `Manifest Digest`): their VALUES change with
 * every replan, so the old skeleton can only be checked structurally here.
 * The digest values themselves are validated separately by
 * `parseEvidencePlanBinding` (manifest digest must equal the expected
 * previous binding; plan digest must be a sha256 value).
 *
 * Duplicate binding lines are NEVER ignored: the actual file must carry
 * exactly ONE `Plan Digest` line and ONE `Manifest Digest` line (the
 * template has exactly one of each), otherwise the file is not pristine.
 */
function skeletonMatchesIgnoringBindingDigests(actual: string, template: string): boolean {
  const countLines = (value: string, label: string): number => {
    const pattern = new RegExp(`^-\\s*${label}:`, 'gm');
    const matches = value.match(pattern);
    return matches === null ? 0 : matches.length;
  };
  if (countLines(actual, 'Plan Digest') !== 1 || countLines(actual, 'Manifest Digest') !== 1) {
    return false;
  }
  const strip = (value: string): string =>
    value
      .split('\n')
      .filter((line) => !/^-\s*(Plan Digest|Manifest Digest):/.test(line))
      .join('\n');
  return strip(actual) === strip(template);
}

function failed(
  stageId: string,
  mode: RefreshVNextMode,
  errors: readonly VNextCliError[],
  blockedRecovery = false,
): RefreshVNextSliceEvidenceResult {
  return {
    success: false,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    mode,
    refreshed: [],
    recovered: false,
    rolled_back: false,
    blocked_recovery: blockedRecovery,
    errors,
  };
}

function resolveEvidenceDirectory(
  root: string,
  manifest: VNextManifest,
  supplied: string | undefined,
): string {
  if (supplied !== undefined) {
    const suppliedCanonical = resolveRootBoundPath(root, supplied, 'evidence-dir');
    const expectedParents = manifest.slices.map((slice) => {
      const target = resolveRootBoundPath(root, slice.evidence_path, 'manifest evidence_path');
      return path.dirname(target);
    });
    for (const expected of expectedParents) {
      if (expected !== suppliedCanonical) {
        throw new Error(
          `evidence-dir "${supplied}" does not contain declared evidence path parent "${expected}"`,
        );
      }
    }
    return suppliedCanonical;
  }

  const parents = new Set(
    manifest.slices.map((slice) => {
      const target = resolveRootBoundPath(root, slice.evidence_path, 'manifest evidence_path');
      return path.dirname(target);
    }),
  );
  if (parents.size !== 1) {
    throw new Error(
      'declared vNext evidence paths do not share one evidence directory; pass [evidence-dir] explicitly',
    );
  }
  return [...parents][0];
}

/** Every receipt category that would make the Stage admitted/executing. */
function stageReceiptDirectories(root: string, stageId: string): string[] {
  return [
    `.proofloop/receipts/plan/${stageId}`,
    `.proofloop/receipts/tasks/${stageId}`,
    `.proofloop/receipts/cv/${stageId}`,
    `.proofloop/receipts/committer/${stageId}`,
    `.proofloop/receipts/integration/${stageId}`,
    `.proofloop/receipts/stage-gate/${stageId}`,
    `.proofloop/receipts/review/${stageId}`,
  ];
}

/**
 * Pre-admission guard: the refresh operation is only legal while the Stage
 * has NO plan/execution Receipts.  Any persisted receipt (stage plan / SPV /
 * task / CV / commit / integration / gate / review) fails closed before any
 * write, and a symlinked/unreadable receipts path also fails closed.
 */
function checkReceiptAbsence(
  root: string,
  stageId: string,
  errors: VNextCliError[],
): void {
  for (const relative of stageReceiptDirectories(root, stageId)) {
    const canonical = canonicalPathWithinRoot(root, relative);
    if (canonical === null) {
      errors.push(
        vnextError('RECEIPT_ABSENCE_FAILED', `receipt path is not root-bound: "${relative}"`, {
          path: relative,
        }),
      );
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      errors.push(
        vnextError('RECEIPT_ABSENCE_FAILED', `cannot inspect receipt directory "${relative}": ${errorMessage(error)}`, {
          path: relative,
        }),
      );
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      errors.push(
        vnextError('RECEIPT_ABSENCE_FAILED', `receipt path is not a regular directory: "${relative}"`, {
          path: relative,
        }),
      );
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(canonical, { withFileTypes: true });
    } catch (error) {
      errors.push(
        vnextError('RECEIPT_ABSENCE_FAILED', `cannot scan receipt directory "${relative}": ${errorMessage(error)}`, {
          path: relative,
        }),
      );
      continue;
    }
    if (entries.length > 0) {
      errors.push(
        vnextError(
          'RECEIPT_ABSENCE_FAILED',
          `refresh is only legal pre-admission; Stage ${stageId} already has persisted receipts under "${relative}"`,
          { path: relative },
        ),
      );
    }
  }
}

// ============================================================
// Bounded per-file primitives (anchored at the verified directory fd)
// ============================================================

type FileReadResult =
  | { readonly kind: 'ok'; readonly content: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly message: string };

function readFileAt(procPath: string): FileReadResult {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(procPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
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
    return { kind: 'error', message: `cannot open evidence file: ${errorMessage(error)}` };
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      return { kind: 'error', message: 'evidence target changed to a non-regular file' };
    }
    const bytes = fs.readFileSync(fd);
    try {
      return { kind: 'ok', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { kind: 'error', message: 'evidence file is not valid UTF-8' };
    }
  } catch (error) {
    return { kind: 'error', message: `cannot read evidence file: ${errorMessage(error)}` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // best effort
    }
  }
}

type SwapResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'compare-mismatch' }
  | {
      readonly kind: 'verify-failed';
      /** The rename SUCCEEDED but the post-swap verification could not
       *  confirm the new content — the target may hold the new binding. */
      readonly message: string;
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Per-file compare-and-swap: the current content must equal `expected`
 * (compare), then a temp file is written + fsync'd and atomically renamed
 * over the target (swap).  The result is verified by reading the target back.
 * Every failure removes the temp inode and leaves the previous content in
 * place; a compare mismatch means a competitor changed the file mid-flight.
 *
 * S09-REVIEW-001: an atomic identity CAS closes the compare→rename window.
 * Immediately before the rename the target's file identity (dev/ino) AND
 * content binding are revalidated against the values captured at compare
 * time; ANY change fails closed as a compare mismatch — the rename never
 * happens and the replacement is never written over a raced target.
 *
 * `verify-failed` is the dangerous half-swap case: the rename succeeded (the
 * file now holds the replacement content) but the read-back verification
 * failed.  Callers MUST treat a `verify-failed` file as already swapped (add
 * it to the rollback set) so the transaction never deletes its journal while
 * a partial new binding remains unrecoverable.
 */
function swapEvidenceFile(
  procPrefix: string,
  name: string,
  expected: string,
  replacement: string,
): SwapResult {
  const target = `${procPrefix}/${name}`;
  const identityAtCompare = fileIdentityAt(target);
  if (identityAtCompare === null) return { kind: 'compare-mismatch' };
  const current = readFileAt(target);
  if (current.kind === 'absent') return { kind: 'compare-mismatch' };
  if (current.kind === 'error') return current;
  if (current.content !== expected) return { kind: 'compare-mismatch' };

  const tempName = `.${name}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const temp = `${procPrefix}/${tempName}`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, flags, 0o644);
    const bytes = Buffer.from(replacement, 'utf-8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error('short write while swapping evidence file');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // S09-REVIEW-001: atomic identity CAS — the target must still be the
    // SAME inode holding the SAME content the compare saw, otherwise the
    // rename is refused (fail closed, zero writes over the raced target).
    const identityBeforeRename = fileIdentityAt(target);
    if (identityBeforeRename === null || identityBeforeRename !== identityAtCompare) {
      return { kind: 'compare-mismatch' };
    }
    const bindingBeforeRename = readFileAt(target);
    if (bindingBeforeRename.kind !== 'ok' || bindingBeforeRename.content !== expected) {
      return { kind: 'compare-mismatch' };
    }

    fs.renameSync(temp, target);
    const after = readFileAt(target);
    if (after.kind !== 'ok') {
      return {
        kind: 'verify-failed',
        message:
          after.kind === 'error'
            ? `post-swap verification failed for "${name}": ${after.message}`
            : `post-swap verification failed for "${name}": target vanished after rename`,
      };
    }
    if (after.content !== replacement) {
      return {
        kind: 'verify-failed',
        message: `post-swap verification failed for "${name}": content does not match the replacement`,
      };
    }
    return { kind: 'ok' };
  } catch (error) {
    return { kind: 'error', message: `evidence swap failed for "${name}": ${errorMessage(error)}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // ENOENT is normal after a successful rename; cleanup is best effort.
    }
  }
}

/** dev:ino identity of the target file (null when absent/unreadable). */
function fileIdentityAt(procPath: string): string | null {
  try {
    const stat = fs.lstatSync(procPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function readJournalAt(procPrefix: string): JournalReadResult {
  const read = readFileAt(`${procPrefix}/${REFRESH_JOURNAL_FILE}`);
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'error') {
    return { kind: 'invalid', message: read.message };
  }
  let value: unknown;
  try {
    value = JSON.parse(read.content);
  } catch (error) {
    return { kind: 'invalid', message: `refresh journal is not valid JSON: ${errorMessage(error)}` };
  }
  if (!isJournalFile(value)) {
    return { kind: 'invalid', message: 'refresh journal has an invalid shape' };
  }
  return { kind: 'ok', journal: value };
}

/**
 * Remove the transaction journal.  Returns true when the journal is gone;
 * false when the removal failed (EACCES etc.) — the caller MUST then report
 * blocked recovery and keep the journal so the transaction stays recoverable
 * (S09-REVIEW-001: a failed removal is never silently reported as success).
 */
function removeJournal(procPrefix: string): boolean {
  try {
    fs.unlinkSync(`${procPrefix}/${REFRESH_JOURNAL_FILE}`);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Refresh transaction
// ============================================================

/**
 * Execute the refresh transaction.  Default mode is `refresh` (preflight +
 * journal + per-file CAS + journal removal).  `recover` completes an
 * interrupted journaled transaction; `rollback` reverts it.  The function
 * never reports a partial update as success.
 */
export function refreshVNextSliceEvidence(
  request: RefreshVNextSliceEvidenceRequest,
): RefreshVNextSliceEvidenceResult {
  const mode: RefreshVNextMode = request.mode ?? 'refresh';
  if (mode !== 'refresh' && mode !== 'recover' && mode !== 'rollback') {
    return failed('unknown', 'refresh', [
      vnextError('USAGE', `mode must be one of refresh|recover|rollback, got "${String(request.mode)}"`),
    ]);
  }

  let root: string;
  try {
    root = resolveProjectRoot(request.projectRoot);
  } catch (error) {
    return failed('unknown', mode, [vnextError('ROOT_ERROR', errorMessage(error))]);
  }

  let manifestValue: unknown;
  try {
    manifestValue = readRootBoundJson(root, request.manifestPath, 'manifest').value;
  } catch (error) {
    return failed('unknown', mode, [
      vnextError('MANIFEST_READ_FAILED', `manifest cannot be read as a root-bound JSON file: ${errorMessage(error)}`, {
        path: request.manifestPath,
      }),
    ]);
  }

  const checked = validateVNextManifestArtifact(root, manifestValue, {
    verifyReferenceDigests: true,
  });
  if (checked.manifest === null || checked.errors.length > 0) {
    return failed(checked.stage_id, mode, checked.errors);
  }
  const manifest = checked.manifest;

  if (typeof request.previousManifestDigest !== 'string' || !SHA256_HEX_RE.test(request.previousManifestDigest)) {
    return failed(manifest.stage_id, mode, [
      vnextError(
        'PREVIOUS_DIGEST_INVALID',
        'previousManifestDigest must be a 64-hex sha256 digest',
      ),
    ]);
  }
  const manifestDigest = computeVNextManifestDigest(manifest);

  let targetEvidenceDir: string;
  try {
    targetEvidenceDir = resolveEvidenceDirectory(root, manifest, request.evidenceDir);
  } catch (error) {
    return failed(manifest.stage_id, mode, [
      vnextError('EVIDENCE_PATH_INVALID', errorMessage(error), { path: request.evidenceDir }),
    ]);
  }

  // ZERO-WRITE preflight: the pre-admission receipt absence check runs BEFORE
  // the evidence directory is created or opened.  A post-admission Stage (or
  // an unreadable/symlinked receipts path) is rejected without creating the
  // evidence directory or the journal — the refresh operation writes nothing
  // when any preflight condition fails.
  const errors: VNextCliError[] = [];
  checkReceiptAbsence(root, manifest.stage_id, errors);
  if (errors.length > 0) return failed(manifest.stage_id, mode, errors);

  let verified: ReturnType<typeof ensureDirectoryNoFollow>;
  try {
    verified = ensureDirectoryNoFollow(root, targetEvidenceDir);
  } catch (error) {
    return failed(manifest.stage_id, mode, [
      vnextError('EVIDENCE_DIR_ERROR', errorMessage(error), { path: targetEvidenceDir }),
    ]);
  }

  let opened: ReturnType<typeof openVerifiedDirectory>;
  try {
    opened = openVerifiedDirectory(verified);
  } catch (error) {
    return failed(manifest.stage_id, mode, [
      vnextError('EVIDENCE_DIR_CHANGED', errorMessage(error), { path: targetEvidenceDir }),
    ]);
  }

  const procPrefix = opened.procPrefix;
  try {
    // Journal state decides refresh vs recovery.
    const journalState = readJournalAt(procPrefix);

    if (mode === 'refresh') {
      if (journalState.kind === 'invalid') {
        return failed(manifest.stage_id, mode, [
          vnextError('UNRECOVERED_TRANSACTION', journalState.message ?? 'refresh journal is unreadable', {
            path: REFRESH_JOURNAL_FILE,
          }),
        ]);
      }
      if (journalState.kind === 'ok') {
        return failed(
          manifest.stage_id,
          mode,
          [
            vnextError(
              'UNRECOVERED_TRANSACTION',
              'an interrupted refresh transaction is still present; run recover or rollback before any fresh refresh',
              { path: REFRESH_JOURNAL_FILE },
            ),
          ],
          true,
        );
      }
      return runFreshRefresh(manifest, manifestDigest, request.previousManifestDigest, procPrefix, errors);
    }

    if (journalState.kind === 'absent') {
      return failed(manifest.stage_id, mode, [
        vnextError('NO_TRANSACTION', `no refresh journal exists; nothing to ${mode}`, {
          path: REFRESH_JOURNAL_FILE,
        }),
      ]);
    }
    if (journalState.kind === 'invalid') {
      return failed(
        manifest.stage_id,
        mode,
        [
          vnextError(
            'UNRECOVERED_TRANSACTION',
            journalState.message ?? 'refresh journal is unreadable',
            { path: REFRESH_JOURNAL_FILE },
          ),
        ],
        true,
      );
    }
    const journal = journalState.journal as RefreshJournalFile;
    if (
      journal.stage_id !== manifest.stage_id ||
      journal.manifest_ref !== manifest.plan.ref ||
      journal.manifest_digest !== manifestDigest
    ) {
      return failed(
        manifest.stage_id,
        mode,
        [
          vnextError(
            'JOURNAL_BINDING_MISMATCH',
            `refresh journal is bound to a different Manifest than the requested one (${mode} refused)`,
            { path: REFRESH_JOURNAL_FILE },
          ),
        ],
        true,
      );
    }

    // The journal must be bound to the SAME previous Manifest digest the
    // operator is asking to recover/roll back from; a forged journal with a
    // different previous binding is never acted on.
    if (journal.previous_manifest_digest !== request.previousManifestDigest) {
      return failed(
        manifest.stage_id,
        mode,
        [
          vnextError(
            'JOURNAL_BINDING_MISMATCH',
            `refresh journal is bound to a different previous Manifest digest than requested (${mode} refused)`,
            { path: REFRESH_JOURNAL_FILE },
          ),
        ],
        true,
      );
    }

    // The journal file set must EXACTLY equal the Manifest-declared evidence
    // set: recovery must never touch an undeclared file and must never report
    // success for an incomplete transaction.
    const declared = manifest.slices
      .map((slice) => path.basename(slice.evidence_path))
      .sort();
    const journaled = journal.files.map((entry) => entry.name).sort();
    if (declared.length !== journaled.length || declared.some((name, index) => name !== journaled[index])) {
      return failed(
        manifest.stage_id,
        mode,
        [
          vnextError(
            'JOURNAL_BINDING_MISMATCH',
            `refresh journal file set does not exactly match the Manifest declarations (${mode} refused)`,
            { path: REFRESH_JOURNAL_FILE },
          ),
        ],
        true,
      );
    }
    return runJournalRecovery(mode, journal, manifest, manifestDigest, procPrefix);
  } finally {
    try {
      const dirfd = opened.dirfd;
      if (typeof dirfd === 'number') {
        fs.closeSync(dirfd);
      }
    } catch {
      // best-effort descriptor cleanup
    }
  }
}

/**
 * Fresh refresh: competitor scan + full pristine/old-binding preflight over
 * EVERY declared evidence file, then journal + per-file CAS with in-process
 * rollback on failure.  Success requires full coverage.
 */
function runFreshRefresh(
  manifest: VNextManifest,
  manifestDigest: string,
  previousManifestDigest: string,
  procPrefix: string,
  errors: VNextCliError[],
): RefreshVNextSliceEvidenceResult {
  const stageId = manifest.stage_id;

  // 2a. Competitor / extra entry scan.  The evidence directory must contain
  // exactly the declared evidence files (plus the journal we are about to
  // create).  Anything else — extra files, directories, symlinks — fails
  // closed BEFORE the transaction starts.
  const declaredNames = new Set(manifest.slices.map((slice) => path.basename(slice.evidence_path)));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procPrefix, { withFileTypes: true });
  } catch (error) {
    return failed(stageId, 'refresh', [
      vnextError('EVIDENCE_DIR_ERROR', `cannot scan evidence-dir: ${errorMessage(error)}`, { path: procPrefix }),
    ]);
  }
  for (const entry of entries) {
    if (entry.name === REFRESH_JOURNAL_FILE) continue;
    if (declaredNames.has(entry.name)) continue;
    const entryPath = `${procPrefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      errors.push(vnextError('EVIDENCE_SYMLINK', `evidence-dir entry is a symlink: "${entry.name}"`, { path: entryPath }));
    } else {
      errors.push(
        vnextError('EVIDENCE_DIR_COMPETITOR', `evidence-dir contains an undeclared entry: "${entry.name}"`, {
          path: entryPath,
        }),
      );
    }
  }
  if (errors.length > 0) return failed(stageId, 'refresh', errors);

  // 2b. Full preflight: every declared file must still be the initializer's
  // pristine skeleton bound to the expected previous Manifest digest.  The
  // binding digest values are checked via the Plan Binding header (the
  // manifest digest must be the expected previous digest; the plan digest
  // must be a sha256 value — the exact previous plan digest is only known to
  // the previous Manifest), and the rest of the file must match the current
  // template structure exactly (no Task Evidence / CV state / extra content).
  // The file identity (dev:ino) is captured for the journal so recovery can
  // reject a file that was replaced by a different inode.  No file is written
  // before every file has passed.
  const files: Array<{ name: string; old: string; new: string; old_identity: string }> = [];
  for (const slice of manifest.slices) {
    const name = path.basename(slice.evidence_path);
    const target = `${procPrefix}/${name}`;
    const newSkeleton = renderVNextEvidenceSkeleton(manifest, slice, manifestDigest);
    const current = readFileAt(target);
    if (current.kind === 'absent') {
      errors.push(
        vnextError('EVIDENCE_NON_PRISTINE', `declared evidence file is missing: "${name}"`, {
          path: slice.evidence_path,
          slice_id: slice.slice_id,
        }),
      );
      continue;
    }
    if (current.kind === 'error') {
      errors.push(
        vnextError('EVIDENCE_NON_PRISTINE', `declared evidence file is unreadable: ${current.message}`, {
          path: slice.evidence_path,
          slice_id: slice.slice_id,
        }),
      );
      continue;
    }
    const identity = fileIdentityAt(target);
    if (identity === null) {
      errors.push(
        vnextError('EVIDENCE_NON_PRISTINE', `declared evidence file identity cannot be captured: "${name}"`, {
          path: slice.evidence_path,
          slice_id: slice.slice_id,
        }),
      );
      continue;
    }
    const binding = parseEvidencePlanBinding(current.content);
    if (
      binding === null ||
      binding.manifest_digest !== previousManifestDigest ||
      !SHA256_HEX_RE.test(binding.plan_digest)
    ) {
      errors.push(
        vnextError(
          'EVIDENCE_OLD_BINDING_MISMATCH',
          `evidence file is not bound to the expected previous Manifest digest "${previousManifestDigest}"`,
          { path: slice.evidence_path, slice_id: slice.slice_id },
        ),
      );
      continue;
    }
    if (!skeletonMatchesIgnoringBindingDigests(current.content, newSkeleton)) {
      errors.push(
        vnextError(
          'EVIDENCE_NON_PRISTINE',
          'evidence file is not the pristine initializer skeleton (Task Evidence / CV state / duplicate binding lines / other content present)',
          { path: slice.evidence_path, slice_id: slice.slice_id },
        ),
      );
      continue;
    }
    files.push({
      name,
      old: current.content,
      new: newSkeleton,
      old_identity: identity,
    });
  }
  if (errors.length > 0) return failed(stageId, 'refresh', errors);

  // 3. Establish the transaction journal.
  const journal: RefreshJournalFile = {
    version: 1,
    stage_id: stageId,
    manifest_ref: manifest.plan.ref,
    previous_manifest_digest: previousManifestDigest,
    manifest_digest: manifestDigest,
    files,
  };  const journalWrite = writeAtomicEvidence(procPrefix, REFRESH_JOURNAL_FILE, JSON.stringify(journal, null, 2));
  if (journalWrite.kind !== 'created') {
    return failed(
      stageId,
      'refresh',
      [
        vnextError(
          'UNRECOVERED_TRANSACTION',
          journalWrite.kind === 'skipped'
            ? 'a refresh journal already exists; run recover or rollback first'
            : `cannot establish refresh journal: ${journalWrite.message}`,
          { path: REFRESH_JOURNAL_FILE },
        ),
      ],
      true,
    );
  }

  // 4. Per-file compare-and-swap.  On the first failure, roll back every
  // already-swapped file; only when rollback itself fails is the journal
  // retained (blocked recovery).  A `verify-failed` result means the rename
  // SUCCEEDED but the read-back check failed — the file is added to the
  // rollback set so the transaction can never delete its journal while a
  // partial new binding remains unrecoverable.
  const pathByFile = new Map(
    manifest.slices.map((slice) => [path.basename(slice.evidence_path), slice.evidence_path] as const),
  );
  const refreshed: string[] = [];
  const swapped: string[] = [];
  for (const file of journal.files) {
    const result = swapEvidenceFile(procPrefix, file.name, file.old, file.new);
    if (result.kind === 'ok') {
      refreshed.push(pathByFile.get(file.name) ?? file.name);
      swapped.push(file.name);
      continue;
    }
    if (result.kind === 'verify-failed') {
      // The target now holds the replacement (or was raced): treat it as
      // swapped so the in-process rollback restores the old binding.
      swapped.push(file.name);
    }
    const failureMessage =
      result.kind === 'compare-mismatch'
        ? `evidence file changed during the refresh transaction: "${file.name}"`
        : result.message;
    errors.push(
      vnextError('EVIDENCE_SWAP_FAILED', failureMessage, {
        path: `${procPrefix}/${file.name}`,
        slice_id: file.name,
      }),
    );
    // In-process rollback of the files already swapped in THIS transaction.
    let rollbackFailed = false;
    for (const done of swapped) {
      const entry = journal.files.find((candidate) => candidate.name === done);
      if (entry === undefined) continue;
      const revert = swapEvidenceFile(procPrefix, done, entry.new, entry.old);
      if (revert.kind !== 'ok') {
        rollbackFailed = true;
        errors.push(
          vnextError(
            'ROLLBACK_FAILED',
            `cannot restore "${done}" to the previous binding: ${revert.kind === 'compare-mismatch' ? 'content changed' : revert.message}`,
            { path: `${procPrefix}/${done}` },
          ),
        );
      }
    }
    if (rollbackFailed) {
      // The journal stays: the partial state remains detectable and the
      // operator can recover or roll back after the interruption.
      return failed(stageId, 'refresh', errors, true);
    }
    if (!removeJournal(procPrefix)) {
      // S09-REVIEW-001: the journal removal failed — the abort state stays
      // detectable, so this is blocked recovery, never a silent success.
      return failed(
        stageId,
        'refresh',
        [
          ...errors,
          vnextError(
            'JOURNAL_REMOVE_FAILED',
            'the refresh aborted and the transaction journal could not be removed; run recover or rollback',
            { path: REFRESH_JOURNAL_FILE },
          ),
        ],
        true,
      );
    }
    return failed(stageId, 'refresh', errors);
  }

  if (!removeJournal(procPrefix)) {
    // S09-REVIEW-001: every file was refreshed but the journal (the
    // recoverable state) could not be removed — blocked recovery, never a
    // silent success.
    return failed(
      stageId,
      'refresh',
      [
        vnextError(
          'JOURNAL_REMOVE_FAILED',
          'refresh completed but the transaction journal could not be removed; run recover or rollback',
          { path: REFRESH_JOURNAL_FILE },
        ),
      ],
      true,
    );
  }
  return {
    success: true,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    mode: 'refresh',
    refreshed,
    recovered: false,
    rolled_back: false,
    blocked_recovery: false,
    errors: [],
  };
}

/**
 * Recovery/rollback over a persisted journal.  Every file must currently be
 * exactly the journaled old content (not yet swapped), exactly the journaled
 * new content (already swapped), or the recovery fails closed as blocked.
 *
 * File identity is validated against the journal: a file currently holding
 * the OLD content must still be the SAME inode the refresh captured
 * (`old_identity`); a file holding the NEW content must NOT be that inode
 * (the atomic rename necessarily replaced it).  A replaced/recreated file is
 * unrecoverable and fails closed.  The old content's Plan Binding must also
 * still bind to the journaled previous Manifest digest, so a forged journal
 * with tampered old content cannot drive recovery.
 */
function runJournalRecovery(
  mode: 'recover' | 'rollback',
  journal: RefreshJournalFile,
  manifest: VNextManifest,
  manifestDigest: string,
  procPrefix: string,
): RefreshVNextSliceEvidenceResult {
  const stageId = journal.stage_id;
  const sliceByFile = new Map(
    manifest.slices.map((slice) => [path.basename(slice.evidence_path), slice] as const),
  );
  const expected = (entry: { old: string; new: string }): string => (mode === 'recover' ? entry.old : entry.new);
  const replacement = (entry: { old: string; new: string }): string => (mode === 'recover' ? entry.new : entry.old);
  const alreadyDone = (entry: { old: string; new: string }): string => (mode === 'recover' ? entry.new : entry.old);

  // ============================================================
  // Phase 1 — FULL preflight over EVERY journal entry (ZERO writes).
  // The journaled old/new contents must be the canonical skeletons for the
  // CURRENT Manifest (slice/task entities exact, binding digests correct),
  // the on-disk identity must match the journal direction, and the on-disk
  // content must be exactly the journaled old or new.  ANY invalid entry
  // fails the WHOLE transaction before a single file is touched and the
  // journal is retained — a forged journal can never write a file.
  // ============================================================
  const errors: VNextCliError[] = [];
  const pending: Array<{ entry: (typeof journal.files)[number] }> = [];
  for (const entry of journal.files) {
    const slice = sliceByFile.get(entry.name);
    if (slice === undefined) {
      errors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `"${entry.name}" is not a Manifest-declared evidence file; ${mode} is impossible`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }
    const canonicalNew = renderVNextEvidenceSkeleton(manifest, slice, manifestDigest);

    // 1) The journaled OLD content must be the canonical previous skeleton:
    //    binding matches this Manifest (stage/slice/plan ref) plus the
    //    journaled previous digest, and the structure matches the template
    //    exactly (ignoring only the two binding digest VALUES).
    const oldBinding = parseEvidencePlanBinding(entry.old);
    if (
      oldBinding === null ||
      oldBinding.stage_id !== manifest.stage_id ||
      oldBinding.slice_id !== slice.slice_id ||
      oldBinding.plan_ref !== manifest.plan.ref ||
      oldBinding.manifest_digest !== journal.previous_manifest_digest ||
      !SHA256_HEX_RE.test(oldBinding.plan_digest) ||
      !skeletonMatchesIgnoringBindingDigests(entry.old, canonicalNew)
    ) {
      errors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `"${entry.name}" journaled OLD content is not the canonical previous skeleton for this Manifest; ${mode} is impossible`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }

    // 2) The journaled NEW content must be EXACTLY the canonical skeleton for
    //    this slice of the CURRENT Manifest (forged replacement content can
    //    never be written).
    if (entry.new !== canonicalNew) {
      errors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `"${entry.name}" journaled NEW content is not the canonical skeleton for the current Manifest; ${mode} is impossible`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }

    // 3) On-disk state must be exactly the journaled old or new, and the
    //    inode must match the direction this transaction moves the file FROM.
    const current = readFileAt(`${procPrefix}/${entry.name}`);
    if (current.kind === 'error') {
      errors.push(
        vnextError('UNRECOVERABLE_STATE', `cannot inspect "${entry.name}" during ${mode}: ${current.message}`, {
          path: `${procPrefix}/${entry.name}`,
        }),
      );
      continue;
    }
    if (current.kind === 'absent') {
      errors.push(
        vnextError('UNRECOVERABLE_STATE', `declared evidence file is missing during ${mode}: "${entry.name}"`, {
          path: `${procPrefix}/${entry.name}`,
        }),
      );
      continue;
    }
    const identity = fileIdentityAt(`${procPrefix}/${entry.name}`);
    if (identity === null) {
      errors.push(
        vnextError('UNRECOVERABLE_STATE', `cannot capture the identity of "${entry.name}" during ${mode}`, {
          path: `${procPrefix}/${entry.name}`,
        }),
      );
      continue;
    }
    if (current.content === alreadyDone(entry)) {
      // Already reached the target state.  The inode tells the direction:
      //   - recover (alreadyDone = new): the file MUST be the replaced inode
      //     from the swap — the old inode pretending to hold new content is
      //     an in-place modification, unrecoverable;
      //   - rollback (alreadyDone = old): the file was never swapped (or was
      //     already reverted) — it MUST still be the journaled old inode.
      if (mode === 'recover' && identity === entry.old_identity) {
        errors.push(
          vnextError(
            'UNRECOVERABLE_STATE',
            `"${entry.name}" holds the new content on the OLD inode; the file was modified in place and recover is impossible`,
            { path: `${procPrefix}/${entry.name}` },
          ),
        );
      }
      if (mode === 'rollback' && identity !== entry.old_identity) {
        errors.push(
          vnextError(
            'UNRECOVERABLE_STATE',
            `"${entry.name}" holds the old content on a DIFFERENT inode; the file was replaced and rollback is impossible`,
            { path: `${procPrefix}/${entry.name}` },
          ),
        );
      }
      continue;
    }
    if (current.content !== expected(entry)) {
      errors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `"${entry.name}" matches neither the journaled old nor new content; ${mode} is impossible`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }
    if (mode === 'recover' && identity !== entry.old_identity) {
      errors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `"${entry.name}" was replaced by a different inode; ${mode} is impossible`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }
    if (mode === 'rollback' && identity === entry.old_identity) {
      errors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `"${entry.name}" holds the new content on the OLD inode; the file was modified in place and rollback is impossible`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }
    const binding = parseEvidencePlanBinding(current.content);
    const pendingBindingDigest = mode === 'recover' ? journal.previous_manifest_digest : journal.manifest_digest;
    if (binding === null || binding.manifest_digest !== pendingBindingDigest) {
      errors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `"${entry.name}" content is not bound to the journaled digest for ${mode}; ${mode} is impossible`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }
    pending.push({ entry });
  }
  if (errors.length > 0) {
    // Zero writes: every file stays untouched and the journal is retained.
    return failed(stageId, mode, errors, true);
  }

  // ============================================================
  // Phase 2 — unified writes, only after EVERY entry passed preflight.
  // A mid-flight race failure keeps the journal (blocked recovery); the
  // transaction never reports a partial update as success.
  // ============================================================
  const touched: string[] = [];
  const writeErrors: VNextCliError[] = [];
  for (const { entry } of pending) {
    const swap = swapEvidenceFile(procPrefix, entry.name, expected(entry), replacement(entry));
    if (swap.kind !== 'ok') {
      writeErrors.push(
        vnextError(
          'UNRECOVERABLE_STATE',
          `cannot ${mode} "${entry.name}": ${swap.kind === 'compare-mismatch' ? 'content changed' : swap.message}`,
          { path: `${procPrefix}/${entry.name}` },
        ),
      );
      continue;
    }
    touched.push(entry.name);
  }
  if (writeErrors.length > 0) {
    return failed(stageId, mode, writeErrors, true);
  }
  if (!removeJournal(procPrefix)) {
    // S09-REVIEW-001: the journal could not be removed — the transaction is
    // complete but its recovery state remains, so this is blocked recovery.
    return failed(
      stageId,
      mode,
      [
        vnextError(
          'JOURNAL_REMOVE_FAILED',
          `${mode} completed but the transaction journal could not be removed; the journal is retained`,
          { path: REFRESH_JOURNAL_FILE },
        ),
      ],
      true,
    );
  }
  return {
    success: true,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    mode,
    refreshed: touched,
    recovered: mode === 'recover',
    rolled_back: mode === 'rollback',
    blocked_recovery: false,
    errors: [],
  };
}
