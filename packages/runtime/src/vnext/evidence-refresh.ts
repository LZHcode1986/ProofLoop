/**
 * S09-D-T01 — Runtime-owned pre-admission pristine Evidence refresh service;
 * S12-E-T01 — FR-021 post-admission `rebind` mode (replan preserve state).
 *
 * After a Manifest digest changes, `initialize` intentionally skips existing
 * non-empty Evidence skeletons, so the ONLY legal rebind path is this explicit
 * refresh transaction.  The default `refresh` mode is strictly pre-admission:
 * the Stage must have no plan/execution Receipts and every declared Evidence
 * file must still be the initializer's pristine template bound to the expected
 * previous Manifest digest (old binding / root / file identity / receipt
 * absence are fully preflighted BEFORE any write).
 *
 * The `rebind` mode (FR-021) is the post-admission counterpart: after a
 * replan, the evidence of an ADMITTED and CURRENT slice (slice-local mode,
 * v3 INTEGRATION_PASS chain current) may carry historical Task Evidence
 * content — only its binding header (Plan Digest / Manifest Digest) is
 * rewritten to the new Manifest, the content is preserved byte-for-byte and a
 * `## Refresh Record` section (`- label:` format) is appended.  Un-admitted /
 * un-finished slices keep the pristine-only semantics (their files must still
 * be the canonical skeleton bound to the previous digest).  Binding
 * validation fails closed: a malformed header (duplicate binding lines) or a
 * file not bound to the expected previous Manifest digest is never rewritten,
 * and the rebind never bypasses any other validation.  The rebind and the
 * FR-023 validate exemption are complementary paths: after a successful rebind
 * the evidence binds the new Manifest and `validate-vnext-stage` passes
 * without needing the exemption.
 *
 * The update itself is a transaction: a journal file (inside the verified
 * evidence directory) records the old and new content of every declared
 * evidence file (with a per-file `kind: pristine | rebind`), then each file is
 * updated with per-file compare-and-swap (content compare + temp-write +
 * fsync + atomic rename).  Success requires full coverage of every
 * Manifest-declared evidence path.  An in-process write failure rolls the
 * already-swapped files back to the old binding; an interrupted process leaves
 * the journal behind so a fresh refresh/rebind FAILS CLOSED with
 * `blocked_recovery` (never silently continues a partial transaction).
 * `recover` mode completes the journaled transaction and `rollback` mode
 * reverts it — both fail closed when the current file state matches neither
 * the journaled old nor new content.
 *
 * This operation writes no Receipt and changes no checkbox/Task/CV state.  It
 * is the refresh half of the bootstrap contract (Acceptance B / Seam §5.3 /
 * HP-015 / HP-012) and the FR-021 replan rebind half of the slice-local
 * contract (§8.6).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  VNEXT_SCHEMA_VERSION,
  computeDigest,
  isCanonicalStageId,
  validateReceipt,
  verifyReceiptChain,
  verifyReceiptDigest,
  type VNextManifest,
  type VNextManifestSlice,
} from '@proofloop/kernel';
import {
  validateDependencyBinding,
  type VNextDependencyBinding,
} from '@proofloop/kernel/dist/vnext';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import {
  committerReceiptDir,
  cvReceiptDir,
  integrationReceiptDir,
  tasksReceiptDir,
} from '../receipt-layout';
import {
  isIntegratedSliceCurrent,
  type IntegrationReceiptRef,
} from './binding-currentness';
import {
  ReplanEpochError,
  deriveHistoricalInvalidatedBindings,
  deriveLineageReceiptExemptions,
  loadAncestorReplanDispositionRecords,
  produceAndPersistReplanDispositionFact,
  readCurrentEpoch,
  readReplanDispositionFact,
  verifyReplanAdmissionFact,
} from './replan-epoch';
import type {
  ReplanCurrentEpoch,
  ReplanDispositionFact,
  ReplanHistoricalInvalidatedBinding,
  ReplanLineageReceiptExemptions,
} from './replan-epoch';
import {
  REPLAN_JOURNAL_FILE,
  REPLAN_EVIDENCE_ROTATION_BLOCKED,
  computeReplanDispositionDigest,
  parseReplanDisposition,
} from './evidence-rotation';
import type { ReplanDisposition } from './evidence-rotation';
import {
  assertSliceLocalCredentialBindingFields,
  assertUpstreamCvPassSemantics,
  assertUpstreamSliceCommitSemantics,
  assertUpstreamTaskCompleteSemantics,
  computeSliceLocalCredentialExpectation,
  credentialSchemaVersionMismatch,
  vnextSliceAllowedScope,
  vnextUpstreamSliceLocalBindingExpectation,
} from './cv-validation';
import {
  VNEXT_INTEGRATION_ACTION,
  VNEXT_INTEGRATION_RESULT_TYPE,
  VNEXT_SLICE_COMMIT_ACTION,
  VNEXT_SLICE_COMMIT_RESULT_TYPE,
} from './types';
import {
  computeVNextManifestDigest,
  ensureDirectoryNoFollow,
  errorMessage,
  openVerifiedDirectory,
  readRootBoundFile,
  readRootBoundJson,
  REFRESH_JOURNAL_FILE,
  renderVNextEvidenceSkeleton,
  resolveExistingDirectory,
  resolveProjectRoot,
  resolveRootBoundPath,
  validateVNextManifestArtifact,
  vnextError,
  writeAtomicEvidence,
  parseEvidencePlanBinding,
  type VNextCliError,
} from '../cli/vnext-cli-support-vnext';

export { REFRESH_JOURNAL_FILE } from '../cli/vnext-cli-support-vnext';

export type RefreshVNextMode = 'refresh' | 'recover' | 'rollback' | 'rebind' | 'replan';

/** S15-A-T02 — mode=replan rotation transaction phase (per-slice journal). */
export type ReplanRefreshPhase = 'rotate' | 'recover' | 'rollback';

export interface RefreshVNextSliceEvidenceRequest {
  /** Root-relative (or root-bound) path of the CURRENT compiled vNext Manifest. */
  readonly manifestPath: string;
  /** Expected previous Manifest digest that every skeleton must still bind. */
  readonly previousManifestDigest: string;
  readonly previousManifestRef?: string;
  readonly evidenceDir?: string;
  readonly projectRoot?: string;
  readonly mode?: RefreshVNextMode;
  /**
   * S15-A-T02 — mode=replan: root-relative, digest-addressed Runtime
   * preparation disposition fact ref (`.proofloop/runtime/replan/**`).  The
   * Runtime reads and verifies the fact itself; a caller can never declare
   * derived sets (§8.8).
   */
  readonly dispositionRef?: string;
  /** S15-A-T02 — mode=replan: content digest of the preparation fact. */
  readonly dispositionDigest?: string;
  /** S15-A-T02 — mode=replan: rotation transaction phase (default `rotate`). */
  readonly replanPhase?: ReplanRefreshPhase;
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
  /** S15-A-T02 (mode=replan only): the rotation transaction phase. */
  readonly replan_phase?: ReplanRefreshPhase;
  /** S15-A-T02 (mode=replan only): the verified disposition fact digest. */
  readonly disposition_digest?: string;
  /** S15-A-T02 (mode=replan only): the parent epoch bound by the disposition. */
  readonly parent_epoch_digest?: string;
  /** S15-A-T02 (mode=replan only): root-relative append-only history archives written. */
  readonly archive_paths?: readonly string[];
  /** S15-A-T02 (mode=replan only): the bounded tasks.md projection was restored. */
  readonly projection_restored?: boolean;
}

/** Per-file transaction kind: pristine skeleton swap (refresh) or
 *  FR-021 content-preserving binding-header rebind.  A mixed stage (some
 *  slices admitted+current, others not) carries both kinds in one journal.
 *  Journals written before S12-E-T01 carry no `kind` — they are pristine. */
export type RefreshJournalEntryKind = 'pristine' | 'rebind';

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
    readonly kind?: RefreshJournalEntryKind;
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
    if (file.kind !== undefined && file.kind !== 'pristine' && file.kind !== 'rebind') {
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

// ============================================================
// S12-E-T01 — FR-021 content-preserving binding-header rebind
// ============================================================

/** The `## Refresh Record` section title appended by a rebind. */
export const REBIND_REFRESH_RECORD_SECTION = '## Refresh Record';

/** The deterministic `- label:` record of one rebind (no timestamps). */
export function renderRefreshRecordSection(
  previousManifestDigest: string,
  manifestDigest: string,
): string {
  return `${REBIND_REFRESH_RECORD_SECTION}

- label: vnext-evidence-rebind
- previous manifest digest: ${previousManifestDigest}
- manifest digest: ${manifestDigest}
`;
}

type RebindTransformResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string };

/**
 * FR-021 content-preserving rebind of ONE evidence file.
 *
 * The file's Plan Binding header must parse (exactly one `## Plan Binding`
 * section, exactly one line per binding field) and must be bound to the
 * expected previous Manifest digest; the Stage ID / Slice ID / Plan Ref must
 * match the target Manifest.  The transform then rewrites ONLY the two digest
 * lines (Plan Digest / Manifest Digest) to the target Manifest values and
 * upserts the `## Refresh Record` section (`- label:` format) — every other
 * byte (Task Evidence / Current Slice Evidence / CV Status) is preserved.
 *
 * The result is verified: the rebound binding must EXACTLY match the target
 * Manifest (stage/slice/plan ref + plan digest + manifest digest) — a rebind
 * whose header would not match the target is refused (fail-closed).  The
 * transform is a pure deterministic function of (content, manifest, digests)
 * so the journal recovery can recompute it and reject forged entries.
 */
function rebindTransform(
  content: string,
  manifest: VNextManifest,
  slice: VNextManifestSlice,
  manifestDigest: string,
  previousManifestDigest: string,
): RebindTransformResult {
  const binding = parseEvidencePlanBinding(content);
  if (binding === null) {
    return {
      ok: false,
      reason: 'evidence file has no parseable Plan Binding header (absent or duplicated binding lines)',
    };
  }
  if (binding.stage_id !== manifest.stage_id) {
    return { ok: false, reason: `binding Stage ID "${binding.stage_id}" does not match the Manifest stage "${manifest.stage_id}"` };
  }
  if (binding.slice_id !== slice.slice_id) {
    return { ok: false, reason: `binding Slice ID "${binding.slice_id}" does not match the declared slice "${slice.slice_id}"` };
  }
  if (binding.plan_ref !== manifest.plan.ref) {
    return { ok: false, reason: `binding Plan Ref "${binding.plan_ref}" does not match the Manifest plan ref "${manifest.plan.ref}"` };
  }
  if (!SHA256_HEX_RE.test(binding.plan_digest)) {
    return { ok: false, reason: 'binding Plan Digest is not a 64-hex sha256 digest' };
  }
  if (binding.manifest_digest !== previousManifestDigest) {
    return {
      ok: false,
      reason: `binding Manifest Digest "${binding.manifest_digest}" is not the expected previous Manifest digest "${previousManifestDigest}"`,
    };
  }

  // Rewrite the two digest lines INSIDE the Plan Binding section only (the
  // parser above guarantees exactly one section and exactly one line per
  // field there; a stray `- Plan Digest:` line elsewhere must never move).
  const sectionMatch = /^## Plan Binding$/gm.exec(content);
  if (sectionMatch === null) {
    return { ok: false, reason: 'evidence file has no Plan Binding section' };
  }
  const bodyStart = (sectionMatch.index as number) + sectionMatch[0].length;
  const nextHeader = /^## /gm;
  nextHeader.lastIndex = bodyStart;
  const next = nextHeader.exec(content);
  const bodyEnd = next === null ? content.length : next.index;
  const body = content.slice(bodyStart, bodyEnd);
  const newBody = body
    .replace(/^- Plan Digest: .*$/m, `- Plan Digest: ${manifest.plan.plan_digest}`)
    .replace(/^- Manifest Digest: .*$/m, `- Manifest Digest: ${manifestDigest}`);
  const withNewDigests = content.slice(0, bodyStart) + newBody + content.slice(bodyEnd);

  // Append the `## Refresh Record` section (`- label:` format).  Every
  // rebind APPENDS a new record — a second (or later) replan keeps the full
  // history of refresh records; earlier records are never replaced or
  // merged (CV S12-E-REPAIR-001: a second legal replan must not drop the
  // previous record).
  const recordSection = renderRefreshRecordSection(previousManifestDigest, manifestDigest);
  const normalized = withNewDigests.endsWith('\n') ? withNewDigests : `${withNewDigests}\n`;
  const rebound = `${normalized}${recordSection}`;

  // Fail-closed verification: the rebound binding must EXACTLY match the
  // target Manifest — a rebind that would leave a mismatched header is never
  // produced (the header can never be refreshed to a non-matching target).
  const verified = parseEvidencePlanBinding(rebound);
  if (verified === null) {
    return { ok: false, reason: 'rebound evidence has no parseable Plan Binding header (internal consistency check)' };
  }
  if (
    verified.stage_id !== manifest.stage_id ||
    verified.slice_id !== slice.slice_id ||
    verified.plan_ref !== manifest.plan.ref ||
    verified.plan_digest !== manifest.plan.plan_digest ||
    verified.manifest_digest !== manifestDigest
  ) {
    return {
      ok: false,
      reason: 'rebound evidence binding does not match the target Manifest (internal consistency check)',
    };
  }
  return { ok: true, content: rebound };
}

/**
 * Pure FR-021 rebind of one evidence file (exported for the replan fixture
 * journal construction; returns null when the file cannot be rebound).
 */
export function renderReboundEvidence(
  content: string,
  manifest: VNextManifest,
  slice: VNextManifestSlice,
  manifestDigest: string,
  previousManifestDigest: string,
): string | null {
  const result = rebindTransform(content, manifest, slice, manifestDigest, previousManifestDigest);
  return result.ok ? result.content : null;
}

// ============================================================
// S12-E-T01 — slice-local currentness preflight (admitted+current)
// ============================================================

/** One persisted INTEGRATION_PASS chain entry with its receipt-bound dependency facts. */
interface VNextSliceLocalChainEntry {
  readonly ref: IntegrationReceiptRef;
  readonly dependencyBindings: readonly VNextDependencyBinding[];
}

const REBIND_GIT_SHA_RE = /^[a-f0-9]{40}$/;

function rebindReceiptFactDigest(value: unknown, label: string, length: 40 | 64): string {
  const pattern = length === 64 ? SHA256_HEX_RE : REBIND_GIT_SHA_RE;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is not a valid ${length === 40 ? 'Git' : 'SHA-256'} digest`);
  }
  return value;
}

/**
 * One persisted upstream credential (TASK_COMPLETE / CV_PASS | CV_REPAIR /
 * SLICE_COMMIT) referenced by an INTEGRATION_PASS payload.  The referenced
 * chain category must be a valid receipt chain and the digest-addressed
 * receipt must exist; a missing directory contributes null (the reference
 * then fails closed — a self-consistent INTEGRATION_PASS whose upstream
 * credentials do not exist is never CURRENT).
 */
interface UpstreamChainReceipt {
  readonly digest: string;
  readonly type: string;
  readonly stage_id: string;
  /** Kernel Receipt slice_id is optional; the comparisons fail closed on undefined. */
  readonly slice_id: string | undefined;
  readonly payload: Record<string, unknown>;
}

function readUpstreamReceipt(
  root: string,
  directory: string,
  digest: string,
  category: string,
): UpstreamChainReceipt | null {
  const chainResult = verifyReceiptChain(directory);
  if (!chainResult.valid) {
    throw new Error(`${category} Receipt chain is invalid`);
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${category} Receipt directory could not be read: ${directory}`);
  }
  const file = names.find((name) => name === `${digest}.json`);
  if (file === undefined) return null;
  const fullPath = path.join(directory, file);
  const opened = openNoFollowRead(root, fullPath);
  if (!opened.ok) {
    throw new Error(`${category} Receipt is not root-bound: ${file}`);
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
    const receipt = validateReceipt(parsed);
    if (receipt.digest !== digest) {
      throw new Error(`${category} Receipt ${file} is not digest-addressed by ${digest}`);
    }
    if (!verifyReceiptDigest(fullPath)) {
      throw new Error(`${category} Receipt ${file} has an invalid digest`);
    }
    const payload = receipt.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error(`${category} Receipt payload must be a JSON object`);
    }
    return {
      digest: receipt.digest,
      type: receipt.type,
      stage_id: receipt.stage_id,
      slice_id: receipt.slice_id,
      payload: payload as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`${category} Receipt ${file} is invalid: ${String(error)}`);
  } finally {
    fs.closeSync(opened.fd);
  }
}

/**
 * S12-E REPAIR-FINAL: the upstream SLICE_COMMIT credential's commit boundary
 * must be a REAL Git commit that is the current HEAD or an ancestor of it
 * (commit_sha 存在且为 Git 祖先) — a self-consistent digest-addressed
 * SLICE_COMMIT referencing a foreign or non-existent commit is never CURRENT.
 */
function assertRebindGitCommitAncestor(root: string, commitSha: string, label: string): void {
  let head: string;
  try {
    const resolved = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--verify', `${commitSha}^{commit}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (resolved !== commitSha) {
      throw new Error(`${label} does not resolve to the referenced Git commit`);
    }
    head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(
      `${label} is not a real Git commit boundary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (head === commitSha) return;
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', commitSha, head], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw new Error(`${label} is not the current Git HEAD or an ancestor of it`);
  }
}

/**
 * S12-E REPAIR-FINAL: the digest of the Worker (TASK_COMPLETE) chain tip of
 * one Slice (null when no Worker receipts exist).  The CV credential's
 * worker_receipt_digest must bind this tip.
 */
function rebindWorkerChainTipDigest(root: string, stageId: string, sliceId: string): string | null {
  const directory = tasksReceiptDir(root, stageId, sliceId);
  const chainResult = verifyReceiptChain(directory);
  if (!chainResult.valid) {
    throw new Error(`vNext Worker Receipt chain is invalid for ${stageId}/${sliceId}`);
  }
  const tipPath = chainResult.receipts[chainResult.receipts.length - 1];
  if (tipPath === undefined) return null;
  return path.basename(tipPath).replace(/\.json$/, '');
}

/**
 * S12-E REPAIR-FINAL round 3 — context 落盘绑定: the context_ref file must
 * EXIST at `.proofloop/context/<context_digest>.json` and its content digest
 * (canonical digest over the record without `context_digest`) must equal
 * context_digest.  A TASK_COMPLETE credential whose Context was never
 * persisted — or whose persisted content does not match the digest — is not
 * a CURRENT upstream credential and fails the whole rebind preflight closed.
 */
function assertRebindContextPersisted(root: string, contextRef: string, contextDigest: string): void {
  const read = readRootBoundJson(root, contextRef, 'TASK_COMPLETE Context');
  if (typeof read.value !== 'object' || read.value === null || Array.isArray(read.value)) {
    throw new Error('TASK_COMPLETE Context is not a JSON object');
  }
  const context = read.value as Record<string, unknown>;
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  if (context.context_digest !== contextDigest || computeDigest(withoutDigest) !== contextDigest) {
    throw new Error('TASK_COMPLETE Context is not persisted at its digest address (content digest mismatch)');
  }
}

/**
 * Read the current INTEGRATION_PASS receipt chain of every Slice (slice-local
 * mode only, §8.7) — the same fail-closed read the FR-023 validate exemption
 * performs (S12-D-T03): each persisted receipt must be a legal v3 slice-local
 * credential (credential schema_version discriminated FIRST through the
 * shared cv-validation helper; binding fields validated against the Manifest
 * contract digests and the recomputed execution binding).  S12-E REPAIR-001
 * strengthens the read with the complete fact chain: the payload must be the
 * closed vNext INTEGRATION_RESULT fact (type/action), bound to the same
 * stage/slice, carrying the Manifest/Plan/Proof-Index digests, and the
 * upstream TASK_COMPLETE → CV → SLICE_COMMIT credentials it references must
 * EXIST in their persisted chains (each chain valid) with matching
 * stage/slice bindings — the SLICE_COMMIT credential must also carry the
 * same commit boundary.  A forged INTEGRATION_PASS that is self-consistent
 * but lacks type/action or the upstream credentials is NEVER CURRENT.  A
 * malformed chain entry aborts the whole evaluation — the rebind disposition
 * must never be computed over partial facts.
 */
function readRebindIntegrationChain(root: string, manifest: VNextManifest): VNextSliceLocalChainEntry[] {
  const chain: VNextSliceLocalChainEntry[] = [];
  for (const slice of manifest.slices) {
    const directory = integrationReceiptDir(root, manifest.stage_id, slice.slice_id);
    if (canonicalPathWithinRoot(root, directory) === null) {
      throw new Error('vNext Integration Receipt directory escapes the project root');
    }
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`vNext Integration Receipt directory could not be read: ${directory}`);
    }
    if (names.length === 0) continue;

    const chainResult = verifyReceiptChain(directory);
    if (!chainResult.valid) {
      throw new Error(`vNext Integration Receipt chain is invalid for ${manifest.stage_id}/${slice.slice_id}`);
    }
    // S12-E REPAIR-FINAL: only the INTEGRATION_PASS chain TIP is a CURRENT
    // credential.  Historical chain members are still fully validated below
    // (schema, digest, stage/slice, binding fields) but never contribute
    // currentness facts — the current credential of a Slice is its latest
    // INTEGRATION_PASS fact.
    const orderedChainPaths = chainResult.receipts;
    const tipPath = orderedChainPaths[orderedChainPaths.length - 1];
    const tipName = tipPath === undefined ? null : path.basename(tipPath);
    for (const name of names) {
      const file = path.join(directory, name);
      const opened = openNoFollowRead(root, file);
      if (!opened.ok) {
        throw new Error(`vNext Integration Receipt is not root-bound: ${name}`);
      }
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
        const receipt = validateReceipt(parsed);
        if (receipt.type !== 'INTEGRATION_PASS') {
          throw new Error(`Receipt ${name} is not an INTEGRATION_PASS fact in the integration category`);
        }
        if (!verifyReceiptDigest(file)) {
          throw new Error(`Receipt ${name} has an invalid digest`);
        }
        if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
          throw new Error('vNext Integration Receipt stage/slice binding is invalid');
        }
        const payload = receipt.payload;
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          throw new Error('INTEGRATION_PASS payload must be a JSON object');
        }
        const schemaMismatch = credentialSchemaVersionMismatch(
          payload.schema_version,
          manifest.binding !== undefined,
          'INTEGRATION_PASS.payload',
        );
        if (schemaMismatch !== null) {
          throw new Error(schemaMismatch.message);
        }
        if (payload.receipt_chain_valid !== true) {
          throw new Error('INTEGRATION_PASS Receipt does not assert a valid vNext Receipt chain');
        }
        // S12-E REPAIR-001: the INTEGRATION_PASS credential must be the
        // closed vNext INTEGRATION_RESULT fact bound to the same stage/slice
        // as the receipt — a self-consistent but open (missing type/action)
        // credential is never CURRENT.
        if (payload.type !== VNEXT_INTEGRATION_RESULT_TYPE || payload.action !== VNEXT_INTEGRATION_ACTION) {
          throw new Error('INTEGRATION_PASS Receipt is not the closed vNext INTEGRATION_RESULT fact');
        }
        if (payload.stage_id !== manifest.stage_id || payload.slice_id !== slice.slice_id) {
          throw new Error('INTEGRATION_PASS payload stage/slice binding is invalid');
        }
        for (const field of ['manifest_digest', 'plan_digest', 'proof_index_digest']) {
          rebindReceiptFactDigest(payload[field], `INTEGRATION_PASS.${field}`, 64);
        }
        const stageContractDigest = rebindReceiptFactDigest(
          payload.stage_contract_digest,
          'INTEGRATION_PASS.stage_contract_digest',
          64,
        );
        const sliceContractDigest = rebindReceiptFactDigest(
          payload.slice_contract_digest,
          'INTEGRATION_PASS.slice_contract_digest',
          64,
        );
        const integrationHead = rebindReceiptFactDigest(payload.commit_sha, 'INTEGRATION_PASS.commit_sha', 40);
        // The upstream fact chain: the SLICE_COMMIT / Worker / CV credentials
        // the INTEGRATION_PASS references must EXIST in their persisted
        // chains (each chain valid) and bind the same stage/slice; the
        // SLICE_COMMIT credential must additionally carry the same commit
        // boundary.  A forged INTEGRATION_PASS whose upstream credentials
        // are missing or non-existent fails the whole preflight closed.
        const sliceCommitDigest = rebindReceiptFactDigest(
          payload.slice_commit_receipt_digest,
          'INTEGRATION_PASS.slice_commit_receipt_digest',
          64,
        );
        const workerDigest = rebindReceiptFactDigest(
          payload.worker_receipt_digest,
          'INTEGRATION_PASS.worker_receipt_digest',
          64,
        );
        const cvDigest = rebindReceiptFactDigest(
          payload.cv_receipt_digest,
          'INTEGRATION_PASS.cv_receipt_digest',
          64,
        );
        const sliceCommit = readUpstreamReceipt(
          root,
          committerReceiptDir(root, manifest.stage_id, slice.slice_id),
          sliceCommitDigest,
          'vNext Slice Commit',
        );
        if (sliceCommit === null) {
          throw new Error('INTEGRATION_PASS references a SLICE_COMMIT Receipt that does not exist');
        }
        if (
          sliceCommit.type !== 'SLICE_COMMIT' ||
          sliceCommit.stage_id !== manifest.stage_id ||
          sliceCommit.slice_id !== slice.slice_id
        ) {
          throw new Error('INTEGRATION_PASS upstream SLICE_COMMIT Receipt binding is invalid');
        }
        if (
          sliceCommit.payload.type !== VNEXT_SLICE_COMMIT_RESULT_TYPE ||
          sliceCommit.payload.action !== VNEXT_SLICE_COMMIT_ACTION
        ) {
          throw new Error('INTEGRATION_PASS upstream SLICE_COMMIT Receipt is not the closed vNext SLICE_COMMIT_RESULT fact');
        }
        if (sliceCommit.payload.commit_sha !== integrationHead) {
          throw new Error('INTEGRATION_PASS.commit_sha does not match the upstream SLICE_COMMIT credential');
        }
        const worker = readUpstreamReceipt(
          root,
          tasksReceiptDir(root, manifest.stage_id, slice.slice_id),
          workerDigest,
          'vNext Worker',
        );
        if (worker === null || worker.type !== 'TASK_COMPLETE') {
          throw new Error('INTEGRATION_PASS references a TASK_COMPLETE Receipt that does not exist');
        }
        if (worker.stage_id !== manifest.stage_id || worker.slice_id !== slice.slice_id) {
          throw new Error('INTEGRATION_PASS upstream Worker Receipt binding is invalid');
        }
        const cv = readUpstreamReceipt(
          root,
          cvReceiptDir(root, manifest.stage_id, slice.slice_id),
          cvDigest,
          'vNext CV',
        );
        if (cv === null || cv.type !== 'CV_PASS') {
          throw new Error('INTEGRATION_PASS references a CV_PASS Receipt that does not exist');
        }
        if (cv.stage_id !== manifest.stage_id || cv.slice_id !== slice.slice_id) {
          throw new Error('INTEGRATION_PASS upstream CV Receipt binding is invalid');
        }
        const rawDependencies = payload.dependency_bindings;
        if (rawDependencies === undefined || !Array.isArray(rawDependencies)) {
          throw new Error(
            'INTEGRATION_PASS.dependency_bindings is required on a v3 credential and must be an array',
          );
        }
        const dependencyBindings: VNextDependencyBinding[] = [];
        for (const [index, raw] of rawDependencies.entries()) {
          try {
            validateDependencyBinding(raw);
          } catch (error) {
            throw new Error(
              `INTEGRATION_PASS.dependency_bindings[${index}] is malformed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          dependencyBindings.push(raw as VNextDependencyBinding);
        }
        assertSliceLocalCredentialBindingFields(
          payload,
          'INTEGRATION_PASS.payload',
          manifest.binding !== undefined
            ? computeSliceLocalCredentialExpectation(manifest, slice.slice_id, dependencyBindings, payload)
            : undefined,
        );
        if (tipName !== null && name !== tipName) {
          // Historical INTEGRATION_PASS chain member: fully validated above
          // but never a CURRENT credential (the chain tip alone is current).
          continue;
        }
        // S12-E REPAIR-FINAL — complete admission-chain semantics: the
        // referenced upstream credentials must carry the full field
        // semantics (not only exist with a valid chain).  A self-digest-
        // correct but semantically incomplete upstream credential (missing
        // fields / missing CV PASS / missing SLICE_COMMIT) fails the whole
        // preflight closed — digest self-consistency is never sufficient.
        const workerChainTipDigest = rebindWorkerChainTipDigest(
          root,
          manifest.stage_id,
          slice.slice_id,
        );
        if (workerChainTipDigest === null) {
          throw new Error('INTEGRATION_PASS references a Worker chain that does not exist');
        }
        assertUpstreamTaskCompleteSemantics(worker.payload, slice.evidence_path, 'TASK_COMPLETE', {
          verifyContextPersisted: (contextRef, contextDigest) =>
            assertRebindContextPersisted(root, contextRef, contextDigest),
          stageHasBinding: manifest.binding !== undefined,
          expectedSliceLocalBinding: vnextUpstreamSliceLocalBindingExpectation(
            manifest,
            slice.slice_id,
            dependencyBindings,
            worker.payload as Record<string, unknown>,
            'TASK_COMPLETE',
          ),
          allowedScope: vnextSliceAllowedScope(manifest, slice.slice_id),
        });
        assertUpstreamCvPassSemantics(
          cv.payload,
          'CV_RESULT',
          {
            stageHasBinding: manifest.binding !== undefined,
            expectedSliceLocalBinding: vnextUpstreamSliceLocalBindingExpectation(
              manifest,
              slice.slice_id,
              dependencyBindings,
              cv.payload as Record<string, unknown>,
              'CV_RESULT',
            ),
          },
          workerChainTipDigest,
        );
        assertUpstreamSliceCommitSemantics(sliceCommit.payload, 'SLICE_COMMIT', {
          stageHasBinding: manifest.binding !== undefined,
          expectedSliceLocalBinding: vnextUpstreamSliceLocalBindingExpectation(
            manifest,
            slice.slice_id,
            dependencyBindings,
            sliceCommit.payload as Record<string, unknown>,
            'SLICE_COMMIT',
          ),
          allowedScope: vnextSliceAllowedScope(manifest, slice.slice_id),
        });
        assertRebindGitCommitAncestor(root, integrationHead, 'INTEGRATION_PASS.commit_sha');
        chain.push({
          ref: {
            slice_id: slice.slice_id,
            receipt_digest: receipt.digest,
            integration_head_sha: integrationHead,
            stage_contract_digest: stageContractDigest,
            slice_contract_digest: sliceContractDigest,
          },
          dependencyBindings,
        });
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error(`vNext Integration Receipt ${name} is invalid: ${String(error)}`);
      } finally {
        fs.closeSync(opened.fd);
      }
    }
  }
  return chain;
}

/**
 * FR-021 — the set of declared Slice ids whose evidence may be rebound
 * content-preservingly: slices that are ADMITTED and CURRENT in slice-local
 * mode (§8.5/§10.5) — integrated, with a current stage/slice contract,
 * dependency bindings and integration receipt chain.  A legacy Manifest (no
 * `binding`) and an un-integrated / not-current slice are never in the set:
 * their evidence keeps the pristine-only semantics.
 */
function computeRebindableSliceIds(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
): ReadonlySet<string> {
  const rebindable = new Set<string>();
  if (manifest.binding === undefined) return rebindable;
  const chain = readRebindIntegrationChain(root, manifest);
  if (chain.length === 0) return rebindable;
  const bySlice = new Map(chain.map((entry) => [entry.ref.slice_id, entry] as const));
  const receiptChain = chain.map((entry) => entry.ref);
  for (const slice of manifest.slices) {
    const entry = bySlice.get(slice.slice_id);
    if (entry === undefined) continue; // un-integrated: pristine-only stays
    if (
      isIntegratedSliceCurrent({
        manifest,
        sliceId: slice.slice_id,
        manifestDigest,
        planDigest: manifest.plan.plan_digest,
        stageContractDigest: entry.ref.stage_contract_digest,
        sliceContractDigest: entry.ref.slice_contract_digest,
        dependencyBindings: entry.dependencyBindings,
        integrationReceipts: receiptChain,
      })
    ) {
      rebindable.add(slice.slice_id);
    }
  }
  return rebindable;
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
  if (mode !== 'refresh' && mode !== 'recover' && mode !== 'rollback' && mode !== 'rebind' && mode !== 'replan') {
    return failed('unknown', 'refresh', [
      vnextError('USAGE', `mode must be one of refresh|recover|rollback|rebind|replan, got "${String(request.mode)}"`),
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

  // S12-E-T01 (FR-021): the post-admission rebind path.  It is the legal
  // post-admission counterpart of the pre-admission refresh: it skips the
  // receipt-absence preflight (receipts ARE the precondition of "admitted"),
  // never creates the evidence directory (zero writes on rejection) and
  // resolves each file by its own disposition (admitted+current →
  // content-preserving header rebind; otherwise → pristine-only).
  if (mode === 'rebind') {
    return runRebind(manifest, manifestDigest, request.previousManifestDigest, root, targetEvidenceDir);
  }

  // S15-A-T02 (§8.8): the post-admission Replan preparation/rotation path.
  // It is the ONLY public Replan Evidence rotation entry — it receives the
  // current/parent binding and Manifest digest/ref and lets the Runtime
  // handle disposition, archive, transaction journal, CAS/rollback and the
  // bounded mutable projection recovery.
  if (mode === 'replan') {
    return runReplanRefresh(root, manifest, manifestDigest, request);
  }

  // ZERO-WRITE preflight: the pre-admission receipt absence check runs BEFORE
  // the evidence directory is created or opened.  A post-admission Stage (or
  // an unreadable/symlinked receipts path) is rejected without creating the
  // evidence directory or the journal — the refresh operation writes nothing
  // when any preflight condition fails.
  const errors: VNextCliError[] = [];
  if (mode === 'refresh') {
    checkReceiptAbsence(root, manifest.stage_id, errors);
    if (errors.length > 0) return failed(manifest.stage_id, mode, errors);
  }

  let verified: { physicalPath: string; dev: number; ino: number };
  if (mode === 'refresh') {
    try {
      verified = ensureDirectoryNoFollow(root, targetEvidenceDir);
    } catch (error) {
      return failed(manifest.stage_id, mode, [
        vnextError('EVIDENCE_DIR_ERROR', errorMessage(error), { path: targetEvidenceDir }),
      ]);
    }
  } else {
    // recover/rollback: the evidence directory (and the journal inside it)
    // must already exist — it is never created here (zero writes on
    // rejection).  The receipt-absence preflight for these modes runs AFTER
    // the journal is read below, because a journal with `rebind` entries is
    // a post-admission FR-021 transaction.
    try {
      const existing = resolveExistingDirectory(root, targetEvidenceDir, 'evidence-dir');
      const stat = fs.statSync(existing);
      verified = { physicalPath: existing, dev: stat.dev, ino: stat.ino };
    } catch (error) {
      return failed(manifest.stage_id, mode, [
        vnextError('EVIDENCE_DIR_ERROR', errorMessage(error), { path: targetEvidenceDir }),
      ]);
    }
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

    // S12-E-T01 (FR-021): a journal carrying any `rebind` entry is a
    // post-admission transaction (receipts ARE its precondition) — the
    // pre-admission receipt-absence preflight does not apply to it.  An
    // all-pristine journal is a pre-admission transaction and stays strict.
    if (!journal.files.some((entry) => entry.kind === 'rebind')) {
      const receiptErrors: VNextCliError[] = [];
      checkReceiptAbsence(root, manifest.stage_id, receiptErrors);
      if (receiptErrors.length > 0) return failed(manifest.stage_id, mode, receiptErrors);
    }

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
    if (mode !== 'recover' && mode !== 'rollback') {
      return failed(
        manifest.stage_id,
        mode,
        [
          vnextError(
            'USAGE',
            `mode "${String(mode)}" cannot act on a refresh journal; the replan rotation journal is served by mode=replan`,
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
  const files: Array<{
    name: string;
    old: string;
    new: string;
    old_identity: string;
    kind: RefreshJournalEntryKind;
  }> = [];
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
      kind: 'pristine',
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

  // 4. Per-file compare-and-swap (shared transaction executor).
  return executeJournaledSwap(journal, manifest, procPrefix, 'refresh');
}

/**
 * S12-E-T01 (FR-021) — post-admission rebind entry point.
 *
 * The evidence directory must ALREADY exist (the initializer created it at
 * admission); it is never created here, so every rejection is zero-write.
 * A legacy Manifest (no `binding`) can never rebind — the pristine refresh
 * path stays the only pre-admission path (zero behavior change).
 */
function runRebind(
  manifest: VNextManifest,
  manifestDigest: string,
  previousManifestDigest: string,
  root: string,
  targetEvidenceDir: string,
): RefreshVNextSliceEvidenceResult {
  const stageId = manifest.stage_id;
  if (manifest.binding === undefined) {
    return failed(stageId, 'rebind', [
      vnextError(
        'REBIND_MODE_INVALID',
        'rebind requires a slice-local Manifest (manifest.binding); a legacy Manifest keeps the pristine refresh path unchanged',
      ),
    ]);
  }

  let verified: { physicalPath: string; dev: number; ino: number };
  try {
    const existing = resolveExistingDirectory(root, targetEvidenceDir, 'evidence-dir');
    const stat = fs.statSync(existing);
    verified = { physicalPath: existing, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    return failed(stageId, 'rebind', [
      vnextError('EVIDENCE_DIR_ERROR', errorMessage(error), { path: targetEvidenceDir }),
    ]);
  }

  let opened: ReturnType<typeof openVerifiedDirectory>;
  try {
    opened = openVerifiedDirectory(verified);
  } catch (error) {
    return failed(stageId, 'rebind', [
      vnextError('EVIDENCE_DIR_CHANGED', errorMessage(error), { path: targetEvidenceDir }),
    ]);
  }

  const procPrefix = opened.procPrefix;
  try {
    // A fresh rebind is a fresh transaction: an unrecovered journal blocks it.
    const journalState = readJournalAt(procPrefix);
    if (journalState.kind === 'invalid') {
      return failed(stageId, 'rebind', [
        vnextError('UNRECOVERED_TRANSACTION', journalState.message ?? 'refresh journal is unreadable', {
          path: REFRESH_JOURNAL_FILE,
        }),
      ]);
    }
    if (journalState.kind === 'ok') {
      return failed(
        stageId,
        'rebind',
        [
          vnextError(
            'UNRECOVERED_TRANSACTION',
            'an interrupted refresh transaction is still present; run recover or rollback before any fresh rebind',
            { path: REFRESH_JOURNAL_FILE },
          ),
        ],
        true,
      );
    }
    return runFreshRebind(manifest, manifestDigest, previousManifestDigest, root, procPrefix, []);
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
 * S12-E-T01 (FR-021) — fresh rebind transaction.
 *
 * Per-file disposition: a slice that is ADMITTED and CURRENT (slice-local
 * currentness over the persisted v3 INTEGRATION_PASS chain) gets the
 * content-preserving binding-header rebind (non-pristine allowed); every
 * other slice keeps the pristine-only preflight of the refresh path.  The
 * currentness evaluation is all-or-nothing: a chain that cannot be evaluated
 * fails the WHOLE rebind closed (never partial disposition facts).
 */
function runFreshRebind(
  manifest: VNextManifest,
  manifestDigest: string,
  previousManifestDigest: string,
  root: string,
  procPrefix: string,
  errors: VNextCliError[],
): RefreshVNextSliceEvidenceResult {
  const stageId = manifest.stage_id;

  // 1. Competitor / extra entry scan (identical to refresh).
  const declaredNames = new Set(manifest.slices.map((slice) => path.basename(slice.evidence_path)));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procPrefix, { withFileTypes: true });
  } catch (error) {
    return failed(stageId, 'rebind', [
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
  if (errors.length > 0) return failed(stageId, 'rebind', errors);

  // 2. FR-021 disposition — which declared slices are admitted+current?
  let rebindable: ReadonlySet<string>;
  try {
    rebindable = computeRebindableSliceIds(root, manifest, manifestDigest);
  } catch (error) {
    return failed(stageId, 'rebind', [
      vnextError(
        'REBIND_PREFLIGHT_FAILED',
        `slice-local currentness could not be evaluated; rebind fails closed (zero writes): ${errorMessage(error)}`,
      ),
    ]);
  }

  // 3. Full preflight over EVERY declared file (zero writes before every
  // file passed).  Admitted+current files are rebound content-preservingly;
  // all other files must still be the pristine skeleton bound to the
  // expected previous Manifest digest.
  const files: Array<{
    name: string;
    old: string;
    new: string;
    old_identity: string;
    kind: RefreshJournalEntryKind;
  }> = [];
  for (const slice of manifest.slices) {
    const name = path.basename(slice.evidence_path);
    const target = `${procPrefix}/${name}`;
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

    if (rebindable.has(slice.slice_id)) {
      const rebound = rebindTransform(current.content, manifest, slice, manifestDigest, previousManifestDigest);
      if (!rebound.ok) {
        errors.push(
          vnextError(
            'EVIDENCE_REBIND_BINDING_MISMATCH',
            `evidence file of admitted+current slice cannot be rebound: ${rebound.reason}`,
            { path: slice.evidence_path, slice_id: slice.slice_id },
          ),
        );
        continue;
      }
      files.push({ name, old: current.content, new: rebound.content, old_identity: identity, kind: 'rebind' });
    } else {
      // Un-admitted / un-finished evidence keeps the pristine-only semantics
      // (same preflight as the refresh path).
      const newSkeleton = renderVNextEvidenceSkeleton(manifest, slice, manifestDigest);
      const binding = parseEvidencePlanBinding(current.content);
      if (binding === null || binding.manifest_digest !== previousManifestDigest || !SHA256_HEX_RE.test(binding.plan_digest)) {
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
      files.push({ name, old: current.content, new: newSkeleton, old_identity: identity, kind: 'pristine' });
    }
  }
  if (errors.length > 0) return failed(stageId, 'rebind', errors);

  // 4. Establish the transaction journal (per-file kind).
  const journal: RefreshJournalFile = {
    version: 1,
    stage_id: stageId,
    manifest_ref: manifest.plan.ref,
    previous_manifest_digest: previousManifestDigest,
    manifest_digest: manifestDigest,
    files,
  };
  const journalWrite = writeAtomicEvidence(procPrefix, REFRESH_JOURNAL_FILE, JSON.stringify(journal, null, 2));
  if (journalWrite.kind !== 'created') {
    return failed(
      stageId,
      'rebind',
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

  // 5. Per-file compare-and-swap (shared transaction executor).
  return executeJournaledSwap(journal, manifest, procPrefix, 'rebind');
}

/**
 * Shared transaction executor: per-file compare-and-swap with in-process
 * rollback and journal removal.  On the first failure every already-swapped
 * file is rolled back; only when rollback itself fails is the journal
 * retained (blocked recovery).  A `verify-failed` result means the rename
 * SUCCEEDED but the read-back check failed — the file is added to the
 * rollback set so the transaction can never delete its journal while a
 * partial new binding remains unrecoverable.
 */
function executeJournaledSwap(
  journal: RefreshJournalFile,
  manifest: VNextManifest,
  procPrefix: string,
  mode: 'refresh' | 'rebind',
): RefreshVNextSliceEvidenceResult {
  const stageId = journal.stage_id;
  const errors: VNextCliError[] = [];
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
        ? `evidence file changed during the ${mode} transaction: "${file.name}"`
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
      return failed(stageId, mode, errors, true);
    }
    if (!removeJournal(procPrefix)) {
      // S09-REVIEW-001: the journal removal failed — the abort state stays
      // detectable, so this is blocked recovery, never a silent success.
      return failed(
        stageId,
        mode,
        [
          ...errors,
          vnextError(
            'JOURNAL_REMOVE_FAILED',
            `the ${mode} aborted and the transaction journal could not be removed; run recover or rollback`,
            { path: REFRESH_JOURNAL_FILE },
          ),
        ],
        true,
      );
    }
    return failed(stageId, mode, errors);
  }

  if (!removeJournal(procPrefix)) {
    // S09-REVIEW-001: every file was swapped but the journal (the recoverable
    // state) could not be removed — blocked recovery, never a silent success.
    return failed(
      stageId,
      mode,
      [
        vnextError(
          'JOURNAL_REMOVE_FAILED',
          `${mode} completed but the transaction journal could not be removed; run recover or rollback`,
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

    if (entry.kind === 'rebind') {
      // S12-E-T01 (FR-021): rebind journal entry.  The journaled OLD content
      // must be a rebindable previous evidence of this slice (parseable
      // binding, stage/slice/plan-ref match, bound to the journaled previous
      // digest) and the journaled NEW content must be EXACTLY the canonical
      // rebind of that OLD content — the deterministic pure transform — so a
      // forged replacement can never be written.
      const rebound = rebindTransform(entry.old, manifest, slice, manifestDigest, journal.previous_manifest_digest);
      if (!rebound.ok) {
        errors.push(
          vnextError(
            'UNRECOVERABLE_STATE',
            `"${entry.name}" journaled OLD content is not a rebindable previous evidence for this Manifest; ${mode} is impossible (${rebound.reason})`,
            { path: `${procPrefix}/${entry.name}` },
          ),
        );
        continue;
      }
      if (entry.new !== rebound.content) {
        errors.push(
          vnextError(
            'UNRECOVERABLE_STATE',
            `"${entry.name}" journaled NEW content is not the canonical rebind of the journaled OLD content; ${mode} is impossible`,
            { path: `${procPrefix}/${entry.name}` },
          ),
        );
        continue;
      }
    } else {
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

// ============================================================
// S15-A-T02 — plan refresh-evidence(mode=replan): Runtime-owned
// Replan disposition preparation + Evidence rotation seam (§8.8)
// ============================================================

/** The canonical append-only history archive path rule shared with the
 *  rotation core (evidence-rotation.ts `archivePathOf`): the old canonical
 *  Evidence of one Slice is archived under the parent epoch digest. */
function replanArchivePathOf(stageId: string, parentEpochDigest: string, sliceId: string): string {
  return `delivery/stages/${stageId}/evidence/history/${parentEpochDigest}/${sliceId}.md`;
}

function replanFailed(
  stageId: string,
  errors: VNextCliError[],
  blockedRecovery = false,
): RefreshVNextSliceEvidenceResult {
  return failed(stageId, 'replan', errors, blockedRecovery);
}

/** Closed task-id grammar of the rotation core (evidence-rotation.ts
 *  TASK_ID_GRAMMAR): canonical Stage-Slice-Task ids only. */
const REPLAN_NOOP_TASK_ID_RE = /^S\d+-[A-Z0-9]+-T\d+$/;

/** Closed-schema parser for a strict HEAD-only idempotent no-op replan disposition (§8.8). */
function parseReplanNoOpDisposition(value: unknown): ReplanDisposition | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const required: ReadonlyArray<keyof ReplanDisposition> = [
    'schema_version',
    'stage_id',
    'parent_epoch_digest',
    'impact_scope',
    'changed_task_ids',
    'carry_forward_task_ids',
    'invalidated_task_ids',
    'previous_manifest_digest',
    'manifest_digest',
    'previous_plan_digest',
    'plan_digest',
    'snapshot_digest',
  ];
  if (required.some((field) => !(field in record))) return null;
  const unknown = Object.keys(record).filter((field) => !(required as readonly string[]).includes(field));
  if (unknown.length > 0) return null; // closed schema

  if (record.schema_version !== 1) return null;
  const stageId = record.stage_id;
  if (typeof stageId !== 'string' || !isCanonicalStageId(stageId)) return null;
  const parentEpochDigest = record.parent_epoch_digest;
  if (typeof parentEpochDigest !== 'string' || !SHA256_HEX_RE.test(parentEpochDigest)) return null;
  if (record.impact_scope !== 'task-local') return null;


  // Runtime-repair (HEAD-only no-op carry-forward): the classifier's task-local
  // no-op branch (replan-impact.ts) carries every completed current-epoch Task
  // whose contract digest still exists in the candidate plan, so a no-op
  // disposition may name a NON-EMPTY carry_forward_task_ids set. Only changed/
  // invalidated must stay empty. The carried ids keep the closed task-id grammar
  // of the rotation core (evidence-rotation.ts parseReplanDisposition): canonical
  // grammar, stage-scoped, duplicate-free.
  if (!Array.isArray(record.changed_task_ids) || record.changed_task_ids.length !== 0) return null;
  if (!Array.isArray(record.invalidated_task_ids) || record.invalidated_task_ids.length !== 0) return null;
  const carry = record.carry_forward_task_ids;
  if (!Array.isArray(carry)) return null;
  if (carry.some((id) => typeof id !== 'string')) return null;
  const carryIds = carry as string[];
  if (carryIds.some((id) => !REPLAN_NOOP_TASK_ID_RE.test(id) || !id.startsWith(`${stageId}-`))) return null;
  if (new Set(carryIds).size !== carryIds.length) return null; // duplicates are forged

  const prevManifest = record.previous_manifest_digest;
  const candManifest = record.manifest_digest;
  if (typeof prevManifest !== 'string' || !SHA256_HEX_RE.test(prevManifest)) return null;
  if (typeof candManifest !== 'string' || !SHA256_HEX_RE.test(candManifest)) return null;
  if (prevManifest !== candManifest) return null;

  const prevPlan = record.previous_plan_digest;
  const candPlan = record.plan_digest;
  if (typeof prevPlan !== 'string' || !SHA256_HEX_RE.test(prevPlan)) return null;
  if (typeof candPlan !== 'string' || !SHA256_HEX_RE.test(candPlan)) return null;
  if (prevPlan !== candPlan) return null;

  const snap = record.snapshot_digest;
  if (typeof snap !== 'string' || !/^[0-9a-f]{40}$/.test(snap)) return null;

  return {
    schema_version: 1,
    stage_id: stageId,
    parent_epoch_digest: parentEpochDigest,
    impact_scope: 'task-local',
    changed_task_ids: [],
    carry_forward_task_ids: carryIds,
    invalidated_task_ids: [],
    previous_manifest_digest: prevManifest,
    manifest_digest: candManifest,
    previous_plan_digest: prevPlan,
    plan_digest: candPlan,
    snapshot_digest: snap,
  };
}

export function isReplanNoOpDisposition(disposition: ReplanDisposition): boolean {
  // Runtime-repair (HEAD-only no-op carry-forward): aligned with the classifier
  // (replan-impact.ts task-local no-op branch) — a no-op may carry completed
  // current-epoch Tasks forward; changed/invalidated stay empty and the
  // Manifest/Plan contracts stay unchanged, so the zero-write path is required.
  return (
    disposition.impact_scope === 'task-local' &&
    disposition.changed_task_ids.length === 0 &&
    disposition.invalidated_task_ids.length === 0 &&
    disposition.previous_manifest_digest === disposition.manifest_digest &&
    disposition.previous_plan_digest === disposition.plan_digest
  );
}

/** Closed-schema rotation disposition of the verified fact. */
function parseReplanRotationDisposition(fact: ReplanDispositionFact): ReplanDisposition | null {
  if (fact.disposition.impact_scope === 'unresolved') return null;
  const ordinary = parseReplanDisposition(fact.disposition);
  if (ordinary !== null) return ordinary;
  return parseReplanNoOpDisposition(fact.disposition);
}

/**
 * S15-A-T02 — shared current/parent + Manifest binding verification of the
 * Runtime preparation fact.  Every replan phase (rotate/recover/rollback)
 * must be driven by the SAME verified fact: the disposition is digest-
 * addressed, the parent epoch must be the current epoch (derived from the
 * validated parent chain — never a mutable pointer), the candidate Manifest
 * ref/digests must bind the fact's candidate snapshot, the requested
 * previous Manifest digest must bind the fact's previous snapshot, and the
 * Git HEAD must equal the disposition snapshot (the rotation only ever runs
 * at the exact snapshot the disposition was computed on).
 */
function verifyReplanRotationBindings(
  root: string,
  request: RefreshVNextSliceEvidenceRequest,
  manifest: VNextManifest,
  manifestDigest: string,
):
  | { ok: true; fact: ReplanDispositionFact; disposition: ReplanDisposition; parentEpochDigest: string }
  | { ok: false; errors: VNextCliError[] } {
  const stageId = manifest.stage_id;

  let fact: ReplanDispositionFact;
  let dispositionRef: string;
  let dispositionDigest: string;

  if (typeof request.dispositionRef === 'string' && request.dispositionRef.length > 0) {
    if (typeof request.dispositionDigest !== 'string' || !SHA256_HEX_RE.test(request.dispositionDigest)) {
      return {
        ok: false,
        errors: [
          vnextError(
            'REPLAN_DISPOSITION_MISSING',
            'mode=replan requires the preparation disposition digest (request field "disposition_digest", 64-hex sha256)',
          ),
        ],
      };
    }
    dispositionRef = request.dispositionRef;
    dispositionDigest = request.dispositionDigest;
    try {
      fact = readReplanDispositionFact(root, dispositionRef, dispositionDigest);
    } catch (error) {
      return {
        ok: false,
        errors: [
          vnextError(
            'REPLAN_DISPOSITION_INVALID',
            `Runtime preparation disposition cannot be read/verified (digest-addressed fact under .proofloop/runtime/replan/): ${
              error instanceof Error ? error.message : String(error)
            }`,
            { path: dispositionRef },
          ),
        ],
      };
    }
  } else {
    try {
      const produced = produceAndPersistReplanDispositionFact(root, {
        stageId,
        manifestPath: request.manifestPath,
        previousManifestDigest: request.previousManifestDigest,
        previousManifestRef: request.previousManifestRef,
      });
      fact = produced.fact;
      dispositionRef = produced.factRef;
      dispositionDigest = produced.factDigest;
    } catch (error) {
      return {
        ok: false,
        errors: [
          vnextError(
            'REPLAN_DISPOSITION_INVALID',
            `Runtime failed to produce preparation disposition fact: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { path: request.manifestPath },
          ),
        ],
      };
    }
  }

  const disposition = parseReplanRotationDisposition(fact);
  if (disposition === null) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_DISPOSITION_INVALID',
          fact.disposition.impact_scope === 'unresolved'
            ? `disposition is unresolved (${fact.disposition.unresolved_reason ?? 'unknown'}); replan rotation is not authorized`
            : 'disposition failed the closed rotation schema (derived sets are never caller-supplied, §8.8)',
          { path: dispositionRef },
        ),
      ],
    };
  }
  if (disposition.stage_id !== stageId) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_BINDING_MISMATCH',
          `disposition stage_id "${disposition.stage_id}" does not match the Manifest stage "${stageId}"`,
          { path: dispositionRef },
        ),
      ],
    };
  }

  // current/parent binding: the disposition parent epoch must be the current
  // epoch derived from the validated parent chain.
  let current: ReplanCurrentEpoch;
  try {
    current = readCurrentEpoch(root, stageId);
  } catch (error) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_PARENT_EPOCH_MISMATCH',
          `current epoch is unavailable; replan rotation fails closed: ${
            error instanceof ReplanEpochError ? error.message : String(error)
          }`,
        ),
      ],
    };
  }
  if (current.epoch_digest !== disposition.parent_epoch_digest) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_PARENT_EPOCH_MISMATCH',
          `disposition parent_epoch_digest "${disposition.parent_epoch_digest}" does not match the current epoch "${current.epoch_digest}"`,
          { path: dispositionRef },
        ),
      ],
    };
  }

  // Manifest ref/digest binding: the candidate Manifest the operator points
  // at must be EXACTLY the fact's candidate snapshot.
  const factManifest = canonicalPathWithinRoot(root, fact.manifest_ref);
  const requestManifest = canonicalPathWithinRoot(root, request.manifestPath);
  if (factManifest === null || requestManifest === null || factManifest !== requestManifest) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_BINDING_MISMATCH',
          `disposition fact manifest_ref "${fact.manifest_ref}" does not match the requested Manifest path "${request.manifestPath}"`,
          { path: dispositionRef },
        ),
      ],
    };
  }
  if (
    fact.snapshot.manifest_digest !== manifestDigest ||
    fact.snapshot.plan_digest !== manifest.plan.plan_digest ||
    disposition.manifest_digest !== manifestDigest ||
    disposition.plan_digest !== manifest.plan.plan_digest
  ) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_BINDING_MISMATCH',
          'candidate Manifest digest/plan digest do not match the disposition fact candidate snapshot; the rotation never runs against a Manifest the disposition did not see',
          { path: request.manifestPath },
        ),
      ],
    };
  }

  // Previous Manifest digest binding (the old Evidence binding).
  if (request.previousManifestDigest !== disposition.previous_manifest_digest) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_BINDING_MISMATCH',
          `requested previous Manifest digest does not bind the disposition previous_manifest_digest "${disposition.previous_manifest_digest}"`,
          { path: request.manifestPath },
        ),
      ],
    };
  }

  // Git boundary: the rotation runs at the exact snapshot the disposition was
  // computed on (a moved HEAD fails closed; the fresh SPV seam re-validates
  // the boundary before the epoch admission).
  let head: string;
  try {
    head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_SNAPSHOT_MISMATCH',
          `Git HEAD is unavailable; replan rotation fails closed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ],
    };
  }
  if (head !== disposition.snapshot_digest) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_SNAPSHOT_MISMATCH',
          `disposition snapshot_digest "${disposition.snapshot_digest}" does not match the current Git HEAD "${head}"; replan rotation requires the exact snapshot the disposition was computed on`,
        ),
      ],
    };
  }

  // S15-A-T02 (CV 059af118): the rotation is driven by the Runtime
  // admission/impact oracle — a caller-forged disposition fact with a VALID
  // self-digest (derived sets are never Runtime facts, §8.8) is recomputed
  // from the fact snapshots and rejected when it diverges.  The declared
  // disposition is only accepted when the oracle recomputes the identical
  // disposition.
  try {
    verifyReplanAdmissionFact(
      root,
      dispositionRef,
      dispositionDigest,
      {
        stage_id: stageId,
        parent_epoch_digest: current.epoch_digest,
        manifest_digest: manifestDigest,
        plan_digest: manifest.plan.plan_digest,
        snapshot_digest: head,
      },
      request.manifestPath,
    );
  } catch (error) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_DISPOSITION_INVALID',
          `the Runtime impact oracle rejected the disposition fact: ${
            error instanceof ReplanEpochError ? error.message : String(error)
          }`,
          { path: dispositionRef },
        ),
      ],
    };
  }

  // S15-A-T02 (CV 059af118): the disposition's completed set is a Runtime
  // fact derived from the CURRENT epoch TASK_COMPLETE chain (receipts bound
  // to the previous Manifest/Plan the rotation rotates away from).  A
  // caller-forged completion set — inflated or truncated — fails closed even
  // when the rest of the fact is oracle-consistent.
  let historicalBindings: ReplanHistoricalInvalidatedBinding[] = [];
  let lineageExemptions: ReplanLineageReceiptExemptions | undefined;
  try {
    const ancestorRecords = loadAncestorReplanDispositionRecords(root, stageId, current);
    historicalBindings = deriveHistoricalInvalidatedBindings(ancestorRecords);
    lineageExemptions = deriveLineageReceiptExemptions(ancestorRecords);
  } catch (error) {
    if (error instanceof ReplanEpochError) throw error;
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_DISPOSITION_INVALID',
          'failed to resolve ancestor disposition records: ' + (error instanceof Error ? error.message : String(error)),
          { path: dispositionRef },
        ),
      ],
    };
  }

  const derived = deriveCompletedTaskIdsFromReceipts(
    root,
    manifest,
    disposition.previous_manifest_digest,
    disposition.previous_plan_digest,
    fact.previous_snapshot.snapshot_digest,
    historicalBindings,
    lineageExemptions,
  );
  if (!derived.ok) {
    return {
      ok: false,
      errors: [vnextError('REPLAN_DISPOSITION_INVALID', derived.message, { path: dispositionRef })],
    };
  }
  if (derived.task_ids.join('\n') !== [...fact.completed_task_ids].sort().join('\n')) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_DISPOSITION_INVALID',
          `disposition completed_task_ids do not match the Receipt-derived completion fact (declared [${[...fact.completed_task_ids].join(', ')}], Runtime-derived [${derived.task_ids.join(', ')}])`,
          { path: dispositionRef },
        ),
      ],
    };
  }

  return { ok: true, fact, disposition, parentEpochDigest: disposition.parent_epoch_digest };
}

/**
 * S15-A-T02 (CV 059af118) — derive the disposition's completed task set from
 * the CURRENT epoch TASK_COMPLETE Receipt chain: every receipt must be a
 * root-bound, chain-valid TASK_COMPLETE of the declared Slice whose payload
 * binds the previous Manifest/Plan digests the rotation rotates away from.
 * The sorted derived set is the ONLY accepted completed set; a stale or
 * foreign receipt fails closed.
 */
function deriveCompletedTaskIdsFromReceipts(
  root: string,
  manifest: VNextManifest,
  previousManifestDigest: string,
  previousPlanDigest: string,
  previousSnapshotDigest?: string,
  historicalBindings?: readonly ReplanHistoricalInvalidatedBinding[],
  lineageExemptions?: ReplanLineageReceiptExemptions,
): { ok: true; task_ids: string[] } | { ok: false; message: string } {
  const stageId = manifest.stage_id;
  const completed = new Set<string>();
  const sliceTaskMap = new Map<string, Set<string>>();
  for (const s of manifest.slices) {
    const sliceTasks = Object.keys(manifest.task_scopes ?? {}).filter((id) => id.startsWith(`${s.slice_id}-`));
    sliceTaskMap.set(s.slice_id, new Set(sliceTasks));
  }
  for (const slice of manifest.slices) {
    const directory = tasksReceiptDir(root, stageId, slice.slice_id);
    if (!fs.existsSync(directory)) continue;
    const chainResult = verifyReceiptChain(directory);
    if (!chainResult.valid) {
      return { ok: false, message: `Worker Receipt chain is invalid for ${stageId}/${slice.slice_id}` };
    }
    if (process.env.PROOFLOOP_DEBUG_RECEIPTS === '1') {
      console.log(
        'DEBUG-CHAIN',
        JSON.stringify({
          directory,
          dirExists: fs.existsSync(directory),
          dirEntries: fs.existsSync(directory) ? fs.readdirSync(directory) : [],
          chain: chainResult.receipts,
        }),
      );
    }
    const declaredTasks = sliceTaskMap.get(slice.slice_id);
    for (const name of chainResult.receipts) {
      // verifyReceiptChain returns absolute file paths; path.resolve keeps
      // them absolute (path.join would nest them under the receipt dir).
      const fullPath = path.resolve(directory, name);
      const opened = openNoFollowRead(root, fullPath);
      if (!opened.ok) {
        return { ok: false, message: `Worker Receipt is not root-bound: ${name} (reason ${opened.reason})` };
      }
      let receipt: unknown;
      try {
        receipt = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      } catch {
        return { ok: false, message: `Worker Receipt cannot be read: ${name}` };
      } finally {
        try {
          fs.closeSync(opened.fd);
        } catch {
          // best effort
        }
      }
      let validated: ReturnType<typeof validateReceipt>;
      try {
        validated = validateReceipt(receipt);
      } catch {
        return { ok: false, message: `Worker Receipt is invalid: ${name}` };
      }
      if (validated.type !== 'TASK_COMPLETE' || validated.stage_id !== stageId || validated.slice_id !== slice.slice_id) {
        return { ok: false, message: `Worker Receipt does not bind ${stageId}/${slice.slice_id}: ${name}` };
      }
      const payload = validated.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false, message: `Worker Receipt payload is malformed: ${name}` };
      }
      const record = payload as Record<string, unknown>;
      const mode = record.mode;
      if (mode === undefined) {
        return { ok: false, message: `Worker Receipt has no mode: ${name}` };
      }
      if (mode !== 'implement-task' && mode !== 'recover-task' && mode !== 'finalize-slice') {
        return { ok: false, message: `Worker Receipt mode "${String(mode)}" is invalid: ${name}` };
      }
      const taskIdValue = record.task_id;
      if (mode === 'finalize-slice') {
        if (taskIdValue !== undefined) {
          return { ok: false, message: `Worker Receipt finalize-slice must not carry a task_id: ${name}` };
        }
      } else if (typeof taskIdValue !== 'string' || taskIdValue.length === 0) {
        return { ok: false, message: `Worker Receipt has no task_id: ${name}` };
      }
      if (typeof record.snapshot_digest !== 'string' || record.snapshot_digest.length === 0) {
        return { ok: false, message: `Worker Receipt has no snapshot_digest: ${name}` };
      }
      if (typeof record.manifest_digest !== 'string' || record.manifest_digest.length === 0) {
        return { ok: false, message: `Worker Receipt has no manifest_digest: ${name}` };
      }
      if (typeof record.plan_digest !== 'string' || record.plan_digest.length === 0) {
        return { ok: false, message: `Worker Receipt has no plan_digest: ${name}` };
      }
      if (record.stage_id !== undefined && record.stage_id !== stageId) {
        return { ok: false, message: `Worker Receipt payload stage_id "${record.stage_id}" does not match receipt stage "${stageId}": ${name}` };
      }
      if (record.slice_id !== undefined && record.slice_id !== slice.slice_id) {
        return { ok: false, message: `Worker Receipt payload slice_id "${record.slice_id}" does not match receipt slice "${slice.slice_id}": ${name}` };
      }
      if (mode === 'finalize-slice') {
        if (record.manifest_digest !== previousManifestDigest) {
          return { ok: false, message: `Worker Receipt manifest_digest "${record.manifest_digest}" does not match previous epoch "${previousManifestDigest}": ${name}` };
        }
        if (record.plan_digest !== previousPlanDigest) {
          return { ok: false, message: `Worker Receipt plan_digest "${record.plan_digest}" does not match previous epoch "${previousPlanDigest}": ${name}` };
        }
        if (previousSnapshotDigest !== undefined && record.snapshot_digest !== previousSnapshotDigest) {
          return { ok: false, message: `Worker Receipt snapshot_digest "${record.snapshot_digest}" does not match previous epoch "${previousSnapshotDigest}": ${name}` };
        }
        continue;
      }
      const taskId = taskIdValue as string;
      if (declaredTasks !== undefined) {
        if (!declaredTasks.has(taskId)) {
          return { ok: false, message: `Worker Receipt in slice "${slice.slice_id}" has task_id "${taskId}" not declared in slice: ${name}` };
        }
      } else if (!taskId.startsWith(`${slice.slice_id}-`)) {
        return { ok: false, message: `Worker Receipt in slice "${slice.slice_id}" has cross-slice task_id "${taskId}": ${name}` };
      }
      const isHistoricalInvalidated =
        historicalBindings !== undefined &&
        historicalBindings.some(
          (b) =>
            b.stage_id === stageId &&
            b.manifest_digest === record.manifest_digest &&
            b.plan_digest === record.plan_digest &&
            b.snapshot_digest === record.snapshot_digest &&
            b.task_id === taskId,
        );
      if (isHistoricalInvalidated) {
        continue;
      }

      if (
        lineageExemptions !== undefined &&
        lineageExemptions.invalidated.some(
          (b) =>
            b.stage_id === stageId &&
            b.manifest_digest === record.manifest_digest &&
            b.plan_digest === record.plan_digest &&
            b.snapshot_digest === record.snapshot_digest &&
            b.task_id === taskId,
        )
      ) {
        // Consumer-level exemption: this physical receipt belongs to an
        // ancestor generation whose own disposition invalidated the task — it
        // is stale history for THIS rotation, never a completion fact. A later
        // rotation carrying the task forward legitimizes only the NEWER receipt.
        continue;
      }
      if (
        lineageExemptions !== undefined &&
        lineageExemptions.carriedForward.some(
          (b) =>
            b.stage_id === stageId &&
            b.manifest_digest === record.manifest_digest &&
            b.plan_digest === record.plan_digest &&
            b.snapshot_digest === record.snapshot_digest &&
            b.task_id === taskId,
        )
      ) {
        // The disposition rotating this exact previous snapshot carried the
        // task forward: this receipt remains a valid completion fact.
        completed.add(taskId);
        continue;
      }

      if (record.manifest_digest !== previousManifestDigest) {
        return { ok: false, message: `Worker Receipt manifest_digest "${record.manifest_digest}" does not match previous epoch "${previousManifestDigest}": ${name}` };
      }
      if (record.plan_digest !== previousPlanDigest) {
        return { ok: false, message: `Worker Receipt plan_digest "${record.plan_digest}" does not match previous epoch "${previousPlanDigest}": ${name}` };
      }
      if (previousSnapshotDigest !== undefined && record.snapshot_digest !== previousSnapshotDigest) {
        return { ok: false, message: `Worker Receipt snapshot_digest "${record.snapshot_digest}" does not match previous epoch "${previousSnapshotDigest}": ${name}` };
      }
      completed.add(taskId);
    }
  }
  return { ok: true, task_ids: [...completed].sort() };
}

// ------------------------------------------------------------
// Bounded mutable projection recovery (tasks.md)
// ------------------------------------------------------------

const TASK_ENTITY_MARKER_RE = /^<!--\s*proofloop:entity\s+id="([^"]+)"\s+kind="task"\s*-->\s*$/;
const ANY_ENTITY_MARKER_RE = /^<!--\s*proofloop:entity\s+id="([^"]+)"\s+kind="([^"]+)"\s*-->\s*$/;
const SLICE_BEGIN_MARKER_RE = /^<!--\s*SLICE:([A-Za-z0-9_-]+):BEGIN\s*-->\s*$/;
const SLICE_END_MARKER_RE = /^<!--\s*SLICE:([A-Za-z0-9_-]+):END\s*-->\s*$/;
const SLICE_HEADING_RE = /^##\s+Slice\s+([A-Za-z0-9_-]+)\s+(?:—|-)\s+candidate\s*$/;
const STAGE_TOP_LEVEL_SLICE_HEADING_RE = /^##\s+Slice\s+(?:Graph|(?:→|->)\s*Stage\s+Closure)\s*$/;
const TASK_CHECKBOX_LINE_RE = /^-\s*\[([ xX])\]\s+(\S+)\s+(?:—|-)\s/;
const CHECKBOX_ROW_RE = /^\s*-\s*checkbox:\s*(`?\[([ xX])\]`?)\s*$/;
const WORKER_STATUS_ROW_RE = /^\s*-\s*Worker Status:\s*(`?([A-Za-z_]+)`?)\s*$/;
const CV_STATUS_ROW_RE = /^\s*-\s*Current CV Status:\s*(`?([A-Za-z_]+)`?)\s*$/;
const STAGE_MUTABLE_PROJECTION_RE = /^##\s+(?:Stage\s+)?Mutable Execution Projection\s*$/;

// Captures the optional owning Slice id: `### Mutable Execution Projection`
// (owned positionally by its enclosing Slice section) or
// `### Slice <id> Mutable Execution Projection` (must own that Slice).
const SLICE_PROJ_HEADER_RE = /^###\s+(?:Slice\s+([A-Za-z0-9_-]+)\s+)?Mutable Execution Projection\s*$/;

// Task body field rows that belong ONLY inside a Task entity block. A
// projection section containing any of these proves a Task body leaked into
// the projection area (a projection buried after the last Task marker but
// before the Task body fields is a defect — CV S15-A-RECHECK11).
const TASK_BODY_FIELD_RE = /^\s*-\s*(?:refs|Dependencies|Required Skills|execution_scope):/;

// A `## Slice <id> — candidate` heading belongs at Stage top-level only,
// immediately before its own `<!-- SLICE:<id>:BEGIN -->`; the section scanner
// rejects any `## ` heading inside a Slice section and requires exact full-value
// slice_id and canonical suffix matching, together enforcing the ownership
// and isolation invariants.

/** Line indices of the three mutable projection rows of one projection section. */
interface ProjectionRowSlots {
  checkbox: number;
  worker: number;
  cv: number;
}

/** Structurally-verified Plan projection: canonical section slots + task marker indices. */
export interface PlanProjectionAnalysis {
  stageRows: ProjectionRowSlots;
  sliceRows: Map<string, ProjectionRowSlots>;
  /** taskId -> line index of its anchored entity marker. */
  taskMarkers: Map<string, number>;
}

/**
 * S15-A-T02 — STRICT, independent structural validation of a Plan projection
 * (tasks.md) against the Manifest. This is the SINGLE source of structural
 * truth for both the bounded restore (`renderRestoredPlanProjection`) and the
 * journaled recover/rollback projection step (CV S15-A-REPAIR10-
 * PLAN-MARKER-SECTION-OWNERSHIP-SELF-ORACLE, counterexamples 1-4, RECHECK14):
 *  - every entity marker and SLICE marker must anchor the whole line with exact
 *    syntax (any prefix/suffix pollution or foreign text fails closed);
 *  - every Slice heading must match the exact slice_id and canonical suffix
 *    (foreign headings like `S15-A-FOREIGN` or extra suffixes fail closed);
 *  - no entity marker or SLICE marker may be nested in a Task body, projection
 *    section, post-projection area, or outside valid Slice boundaries;
 *  - a Slice Mutable Execution Projection header that claims a different Slice
 *    id than its enclosing Slice section fails closed (ownership);
 *  - the Slice Mutable Execution Projection section must follow all tasks of the
 *    slice and precede post-projection sections;
 *  - unknown, duplicate, missing, nested, cross-Slice, section-external and
 *    prefix-polluted markers/sections all fail closed.
 * The validator performs NO mutation. Returns projectional row slots and task
 * marker indices so callers can restore values without re-running structural
 * checks. `renderRestoredPlanProjection` is the only mutation entry.
 */
export function validatePlanProjectionStructure(
  tasksMd: string,
  manifest: VNextManifest,
): { ok: true; analysis: PlanProjectionAnalysis } | { ok: false; message: string } {
  if (typeof tasksMd !== 'string' || tasksMd.trim().length === 0) {
    return { ok: false, message: 'Plan projection is empty' };
  }
  const lines = tasksMd.split('\n');

  const manifestSliceIds = new Set(manifest.slices.map((s) => s.slice_id));
  const sliceTaskMap = new Map<string, Set<string>>();
  const allDeclaredTasks = new Set<string>();
  for (const s of manifest.slices) {
    const tasks = Object.keys(manifest.task_scopes ?? {}).filter((id) => id.startsWith(`${s.slice_id}-`));
    sliceTaskMap.set(s.slice_id, new Set(tasks));
    for (const t of tasks) allDeclaredTasks.add(t);
  }

  // 0. Global syntax & marker pollution checks across all lines
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Entity marker pollution check: any line containing entity marker syntax must be a whole-line exact match
    if (line.includes('proofloop:entity') || line.includes('<!-- proofloop:entity')) {
      if (!ANY_ENTITY_MARKER_RE.test(line)) {
        return { ok: false, message: `malformed or prefix/suffix-polluted entity marker at line ${i + 1}: ${line.trim()}` };
      }
    }
    // SLICE marker pollution check: any line containing SLICE marker syntax must be a whole-line exact match
    if (line.includes('SLICE:') || line.includes('<!-- SLICE:')) {
      if (!SLICE_BEGIN_MARKER_RE.test(line) && !SLICE_END_MARKER_RE.test(line)) {
        return { ok: false, message: `malformed or prefix/suffix-polluted SLICE marker at line ${i + 1}: ${line.trim()}` };
      }
    }
    // Slice heading syntax check: any line starting with `## Slice` must be a valid heading for a manifest-declared slice,
    // unless it is a recognized Stage top-level section heading (e.g. `## Slice Graph`, `## Slice → Stage Closure`).
    if (/^##\s+Slice\b/.test(line)) {
      if (STAGE_TOP_LEVEL_SLICE_HEADING_RE.test(line)) {
        continue;
      }
      const headingMatch = SLICE_HEADING_RE.exec(line);
      if (!headingMatch) {
        return { ok: false, message: `malformed Slice heading at line ${i + 1}: ${line.trim()}` };
      }
      const sliceId = headingMatch[1];
      if (!manifestSliceIds.has(sliceId)) {
        return { ok: false, message: `unknown or foreign Slice heading "${sliceId}" at line ${i + 1}` };
      }
    }
  }

  // 1. Stage Mutable Execution Projection (exact cardinality === 1 across file)
  const stageHeaderIndices = lines
    .map((line, idx) => (STAGE_MUTABLE_PROJECTION_RE.test(line) ? idx : -1))
    .filter((idx) => idx !== -1);
  if (stageHeaderIndices.length !== 1) {
    return { ok: false, message: 'Stage Mutable Execution Projection header must appear exactly once' };
  }
  const stageHeaderIndex = stageHeaderIndices[0];
  const firstSliceBegin = lines.findIndex((l) => SLICE_BEGIN_MARKER_RE.test(l));
  if (firstSliceBegin !== -1 && stageHeaderIndex > firstSliceBegin) {
    return { ok: false, message: 'Stage Mutable Execution Projection must appear before any Slice section' };
  }
  let stageEndIndex = lines.length;
  for (let i = stageHeaderIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ') || lines[i].includes('<!-- SLICE:')) {
      stageEndIndex = i;
      break;
    }
  }

  const stageRows: Partial<ProjectionRowSlots> = {};
  for (let i = stageHeaderIndex + 1; i < stageEndIndex; i += 1) {
    const l = lines[i];
    if (
      TASK_BODY_FIELD_RE.test(l) ||
      TASK_CHECKBOX_LINE_RE.test(l) ||
      l.includes('proofloop:entity') ||
      l.includes('SLICE:') ||
      l.startsWith('### ')
    ) {
      return { ok: false, message: `Stage Mutable Execution Projection section contains forbidden content at line ${i + 1}` };
    }
    if (CHECKBOX_ROW_RE.test(l)) {
      if (stageRows.checkbox !== undefined) {
        return { ok: false, message: 'duplicate Stage checkbox row' };
      }
      stageRows.checkbox = i;
    } else if (WORKER_STATUS_ROW_RE.test(l)) {
      if (stageRows.worker !== undefined) {
        return { ok: false, message: 'duplicate Stage Worker Status row' };
      }
      stageRows.worker = i;
    } else if (CV_STATUS_ROW_RE.test(l)) {
      if (stageRows.cv !== undefined) {
        return { ok: false, message: 'duplicate Stage Current CV Status row' };
      }
      stageRows.cv = i;
    }
  }
  if (stageRows.checkbox === undefined || stageRows.worker === undefined || stageRows.cv === undefined) {
    return { ok: false, message: 'Stage Mutable Execution Projection is missing a checkbox/Worker Status/Current CV Status row' };
  }

  // 2. Scan Slice boundaries, headings, Task markers, and Task bodies
  const seenSliceHeadings = new Set<string>();
  const sliceHeadingIndices = new Map<string, number>();
  const seenSliceBegins = new Set<string>();
  const seenSliceEnds = new Set<string>();
  const seenTaskIds = new Set<string>();
  const sliceBegins = new Map<string, number>();
  const sliceEnds = new Map<string, number>();
  const sliceTaskMarkers = new Map<string, number[]>();
  const taskMarkers = new Map<string, number>();
  const claimedProjHeaderIndices = new Set<number>();
  const validEntityMarkerIndices = new Set<number>();

  let currentSliceId: string | null = null;
  let insideTaskBlock = false;
  let currentTaskIdInBlock: string | null = null;
  let inCandidateEntityMarkers = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Check Slice Heading at Stage top level
    const headingMatch = SLICE_HEADING_RE.exec(line);
    if (headingMatch) {
      if (currentSliceId !== null) {
        return { ok: false, message: `Slice heading occurs inside Slice section "${currentSliceId}" at line ${i + 1}` };
      }
      const sliceId = headingMatch[1];
      if (seenSliceHeadings.has(sliceId)) {
        return { ok: false, message: `duplicate Slice heading "${sliceId}" at line ${i + 1}` };
      }
      seenSliceHeadings.add(sliceId);
      sliceHeadingIndices.set(sliceId, i);
      insideTaskBlock = false;
      continue;
    }

    const sliceBegin = SLICE_BEGIN_MARKER_RE.exec(line);
    if (sliceBegin !== null) {
      insideTaskBlock = false;
      const sliceId = sliceBegin[1];
      if (!manifestSliceIds.has(sliceId) || seenSliceBegins.has(sliceId) || currentSliceId !== null) {
        return { ok: false, message: `unknown, duplicate or nested Slice section "${sliceId}" at line ${i + 1}` };
      }
      if (!seenSliceHeadings.has(sliceId)) {
        return { ok: false, message: `Slice section "${sliceId}" begins without preceding Slice heading at line ${i + 1}` };
      }
      seenSliceBegins.add(sliceId);
      sliceBegins.set(sliceId, i);
      currentSliceId = sliceId;
      continue;
    }

    const sliceEnd = SLICE_END_MARKER_RE.exec(line);
    if (sliceEnd !== null) {
      insideTaskBlock = false;
      const sliceId = sliceEnd[1];
      if (currentSliceId !== sliceId || seenSliceEnds.has(sliceId)) {
        return { ok: false, message: `mismatched or duplicate Slice end marker "${sliceId}" at line ${i + 1}` };
      }
      seenSliceEnds.add(sliceId);
      sliceEnds.set(sliceId, i);
      currentSliceId = null;
      continue;
    }

    // Check entity markers
    const entityMatch = ANY_ENTITY_MARKER_RE.exec(line);
    if (entityMatch) {
      const entityId = entityMatch[1];
      const entityKind = entityMatch[2];

      if (entityKind === 'task') {
        if (currentSliceId === null) {
          return { ok: false, message: `Task entity marker "${entityId}" is outside any Slice section at line ${i + 1}` };
        }
        const declaredSliceTasks = sliceTaskMap.get(currentSliceId);
        if (!declaredSliceTasks || !declaredSliceTasks.has(entityId) || !entityId.startsWith(`${currentSliceId}-`)) {
          return { ok: false, message: `Task entity marker "${entityId}" is in the wrong Slice section "${currentSliceId}" at line ${i + 1}` };
        }
        if (seenTaskIds.has(entityId)) {
          return { ok: false, message: `duplicate Task entity marker "${entityId}" at line ${i + 1}` };
        }
        seenTaskIds.add(entityId);
        taskMarkers.set(entityId, i);
        validEntityMarkerIndices.add(i);
        const markerList = sliceTaskMarkers.get(currentSliceId) ?? [];
        markerList.push(i);
        sliceTaskMarkers.set(currentSliceId, markerList);

        const next = lines[i + 1];
        if (next === undefined) {
          return { ok: false, message: `Task entity marker "${entityId}" has no following line` };
        }
        const taskLine = TASK_CHECKBOX_LINE_RE.exec(next);
        if (taskLine === null || taskLine[2] !== entityId) {
          return { ok: false, message: `Task entity marker "${entityId}" must be followed by its own checkbox line at line ${i + 2}` };
        }
        insideTaskBlock = true;
        currentTaskIdInBlock = entityId;
        continue;
      } else if (entityKind === 'goal') {
        if (insideTaskBlock) {
          return { ok: false, message: `Goal entity marker "${entityId}" appears inside Task block "${currentTaskIdInBlock}" at line ${i + 1}` };
        }
        if (currentSliceId === null) {
          validEntityMarkerIndices.add(i);
          continue;
        } else {
          if (entityId !== `${currentSliceId}-goal`) {
            return { ok: false, message: `Slice goal entity marker id "${entityId}" does not match slice "${currentSliceId}" at line ${i + 1}` };
          }
          validEntityMarkerIndices.add(i);
          continue;
        }
      } else {
        if (insideTaskBlock) {
          return { ok: false, message: `entity marker "${entityId}" appears inside Task block "${currentTaskIdInBlock}" at line ${i + 1}` };
        }
        if (inCandidateEntityMarkers || currentSliceId === null) {
          validEntityMarkerIndices.add(i);
          continue;
        } else {
          return { ok: false, message: `entity marker "${entityId}" (${entityKind}) in unexpected location at line ${i + 1}` };
        }
      }
    }

    // Top-level sections tracking
    if (line.startsWith('## ')) {
      if (currentSliceId !== null) {
        return { ok: false, message: `## heading occurs inside Slice section "${currentSliceId}" at line ${i + 1}: ${line.trim()}` };
      }
      insideTaskBlock = false;
      if (line.startsWith('## Candidate Entity Markers')) {
        inCandidateEntityMarkers = true;
      } else {
        inCandidateEntityMarkers = false;
      }
      continue;
    }

    if (line.startsWith('### ')) {
      insideTaskBlock = false;
      continue;
    }

    // Inside a Task block: check forbidden content
    if (insideTaskBlock) {
      if (line.includes('proofloop:entity') || line.includes('SLICE:')) {
        return { ok: false, message: `entity or SLICE marker inside Task block "${currentTaskIdInBlock}" at line ${i + 1}` };
      }
      if (CHECKBOX_ROW_RE.test(line) || WORKER_STATUS_ROW_RE.test(line) || CV_STATUS_ROW_RE.test(line)) {
        return { ok: false, message: `projection row inside Task block "${currentTaskIdInBlock}" at line ${i + 1}` };
      }
    }

    // Outside Slice (between slices or post-slice):
    if (currentSliceId === null && seenSliceBegins.size > 0) {
      if (line.includes('SLICE:')) {
        return { ok: false, message: `SLICE marker outside Slice boundaries at line ${i + 1}` };
      }
      if (line.includes('proofloop:entity') && !inCandidateEntityMarkers) {
        return { ok: false, message: `entity marker outside Slice boundaries at line ${i + 1}` };
      }
      if (CHECKBOX_ROW_RE.test(line) || WORKER_STATUS_ROW_RE.test(line) || CV_STATUS_ROW_RE.test(line)) {
        return { ok: false, message: `projection row outside Slice boundaries at line ${i + 1}` };
      }
      if (TASK_CHECKBOX_LINE_RE.test(line) || TASK_BODY_FIELD_RE.test(line)) {
        return { ok: false, message: `Task content outside Slice boundaries at line ${i + 1}` };
      }
    }
  }

  if (currentSliceId !== null) {
    return { ok: false, message: `unclosed Slice section "${currentSliceId}"` };
  }
  if (seenSliceHeadings.size !== manifest.slices.length) {
    return { ok: false, message: `missing Slice headings (found ${seenSliceHeadings.size}, expected ${manifest.slices.length})` };
  }
  if (seenSliceBegins.size !== manifest.slices.length || seenSliceEnds.size !== manifest.slices.length) {
    return { ok: false, message: 'missing Slice sections or end markers' };
  }
  if (seenTaskIds.size !== allDeclaredTasks.size) {
    return { ok: false, message: 'missing Task entity markers for declared Tasks' };
  }

  // 3. Per-Slice: heading placement, projection header ownership and placement, and projection row slots.
  const sliceRows = new Map<string, ProjectionRowSlots>();
  for (const slice of manifest.slices) {
    const sliceId = slice.slice_id;
    const headingIndex = sliceHeadingIndices.get(sliceId);
    const begin = sliceBegins.get(sliceId);
    const end = sliceEnds.get(sliceId);
    if (headingIndex === undefined || begin === undefined || end === undefined) {
      return { ok: false, message: `missing Slice section boundaries for "${sliceId}"` };
    }
    if (headingIndex > begin) {
      return { ok: false, message: `Slice heading for "${sliceId}" appears after Slice begin marker` };
    }

    const headerLines: number[] = [];
    for (let i = begin + 1; i < end; i += 1) {
      if (SLICE_PROJ_HEADER_RE.test(lines[i])) {
        headerLines.push(i);
      }
    }
    if (headerLines.length !== 1) {
      return { ok: false, message: `Slice "${sliceId}" must have exactly one Slice Mutable Execution Projection header` };
    }
    const projHeaderIndex = headerLines[0];
    claimedProjHeaderIndices.add(projHeaderIndex);

    // CE-2 — header ownership: a header that names a Slice must own the Slice it is physically inside.
    const owned = SLICE_PROJ_HEADER_RE.exec(lines[projHeaderIndex])![1];
    if (owned !== undefined && owned !== sliceId) {
      return {
        ok: false,
        message: `Slice Mutable Execution Projection header inside "${sliceId}" claims a different Slice "${owned}"`,
      };
    }

    // The Slice Mutable Execution Projection must come AFTER every Task of the Slice.
    const markerIndices = sliceTaskMarkers.get(sliceId) ?? [];
    if (markerIndices.length > 0 && projHeaderIndex < markerIndices[markerIndices.length - 1]) {
      return {
        ok: false,
        message: `Slice "${sliceId}" Mutable Execution Projection header appears before a Task entity marker (misplaced section)`,
      };
    }

    // Projection section span: [header, next `### ` heading or Slice END)
    let projSectionEnd = end;
    for (let i = projHeaderIndex + 1; i < end; i += 1) {
      if (lines[i].startsWith('### ') || lines[i].startsWith('## ')) {
        projSectionEnd = i;
        break;
      }
    }

    const rows: Partial<ProjectionRowSlots> = {};
    for (let i = projHeaderIndex + 1; i < projSectionEnd; i += 1) {
      const l = lines[i];
      if (CHECKBOX_ROW_RE.test(l)) {
        if (rows.checkbox !== undefined) {
          return { ok: false, message: `duplicate checkbox row in Slice "${sliceId}" projection` };
        }
        rows.checkbox = i;
      } else if (WORKER_STATUS_ROW_RE.test(l)) {
        if (rows.worker !== undefined) {
          return { ok: false, message: `duplicate Worker Status row in Slice "${sliceId}" projection` };
        }
        rows.worker = i;
      } else if (CV_STATUS_ROW_RE.test(l)) {
        if (rows.cv !== undefined) {
          return { ok: false, message: `duplicate Current CV Status row in Slice "${sliceId}" projection` };
        }
        rows.cv = i;
      } else if (
        TASK_BODY_FIELD_RE.test(l) ||
        TASK_CHECKBOX_LINE_RE.test(l) ||
        l.includes('proofloop:entity') ||
        l.includes('SLICE:') ||
        l.startsWith('## ') ||
        l.startsWith('### ')
      ) {
        return { ok: false, message: `Slice "${sliceId}" projection section contains forbidden content at line ${i + 1}` };
      }
    }
    if (rows.checkbox === undefined || rows.worker === undefined || rows.cv === undefined) {
      return { ok: false, message: `Slice "${sliceId}" projection is missing a checkbox/Worker Status/Current CV Status row` };
    }
    sliceRows.set(sliceId, { checkbox: rows.checkbox, worker: rows.worker, cv: rows.cv });

    // Post-projection section: [projSectionEnd, end)
    for (let i = projSectionEnd; i < end; i += 1) {
      const l = lines[i];
      if (
        CHECKBOX_ROW_RE.test(l) ||
        WORKER_STATUS_ROW_RE.test(l) ||
        CV_STATUS_ROW_RE.test(l) ||
        TASK_BODY_FIELD_RE.test(l) ||
        TASK_CHECKBOX_LINE_RE.test(l)
      ) {
        return { ok: false, message: `projection/Task content after the projection section of Slice "${sliceId}" at line ${i + 1}` };
      }
      if (l.includes('proofloop:entity') || l.includes('SLICE:')) {
        return { ok: false, message: `entity/slice marker (incl. pollution) after the projection section of Slice "${sliceId}" at line ${i + 1}` };
      }
      if (l.startsWith('## ')) {
        return { ok: false, message: `## heading after the projection section of Slice "${sliceId}" at line ${i + 1}` };
      }
    }
  }

  // 4. Global scan — every projection row and every projection header must be claimed
  const validRowIndices = new Set<number>([stageRows.checkbox, stageRows.worker, stageRows.cv]);
  for (const rows of sliceRows.values()) {
    validRowIndices.add(rows.checkbox);
    validRowIndices.add(rows.worker);
    validRowIndices.add(rows.cv);
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (CHECKBOX_ROW_RE.test(lines[i]) || WORKER_STATUS_ROW_RE.test(lines[i]) || CV_STATUS_ROW_RE.test(lines[i])) {
      if (!validRowIndices.has(i)) {
        return { ok: false, message: `extraneous projection row at line ${i + 1}` };
      }
    }
    if (STAGE_MUTABLE_PROJECTION_RE.test(lines[i]) && i !== stageHeaderIndex) {
      return { ok: false, message: `duplicate Stage projection header at line ${i + 1}` };
    }
    if (SLICE_PROJ_HEADER_RE.test(lines[i]) && !claimedProjHeaderIndices.has(i)) {
      return { ok: false, message: `extraneous Slice projection header at line ${i + 1}` };
    }
    if (ANY_ENTITY_MARKER_RE.test(lines[i]) && !validEntityMarkerIndices.has(i)) {
      return { ok: false, message: `extraneous entity marker at line ${i + 1}` };
    }
  }

  return {
    ok: true,
    analysis: {
      stageRows: { checkbox: stageRows.checkbox, worker: stageRows.worker, cv: stageRows.cv },
      sliceRows,
      taskMarkers,
    },
  };
}

/**
 * S15-A-T02 — bounded mutable projection restore of the Plan (tasks.md).
 *
 * The Materializer renders every candidate Task unchecked; after a replan the
 * Runtime EXPLICITLY restores the projection in the bounded mutable scope
 * (§8.8): a carried-forward Task keeps `[x]` (its completion fact survives
 * the replan), every other Task resets to `[ ]`, and each Slice's
 * `- checkbox:` / `- Worker Status:` / `- Current CV Status:` projection rows
 * are restored (`COMPLETED` only when EVERY Task carries forward; `IN_PROGRESS`
 * if some carry forward; `NOT_STARTED` otherwise; CV resets to `NOT_RUN`).
 * The Stage Mutable Execution Projection is restored symmetrically.
 * Structural validity is delegated to `validatePlanProjectionStructure`;
 * returns null on any malformed tasks.md (fail closed) before any mutation.
 */
export function renderRestoredPlanProjection(
  tasksMd: string,
  carriedForwardTaskIds: ReadonlySet<string>,
  manifest: VNextManifest,
): string | null {
  if (typeof tasksMd !== 'string' || tasksMd.trim().length === 0) return null;
  const validated = validatePlanProjectionStructure(tasksMd, manifest);
  if (!validated.ok) return null;
  const { stageRows, sliceRows, taskMarkers } = validated.analysis;
  const lines = tasksMd.split('\n');
  const changed: number[] = [];

  const allTasks = Object.keys(manifest.task_scopes ?? {});
  const setRow = (
    index: number,
    kind: 'checkbox' | 'worker' | 'cv',
    target: string,
  ): void => {
    if (kind === 'checkbox') {
      const current = CHECKBOX_ROW_RE.exec(lines[index])!;
      if (current[2] === target) return;
      lines[index] = lines[index].replace(/\[[ xX]\]/, `[${target}]`);
    } else if (kind === 'worker') {
      const current = WORKER_STATUS_ROW_RE.exec(lines[index])!;
      if (current[2] === target) return;
      lines[index] = lines[index].includes('`')
        ? lines[index].replace(/`[^`]+`/, `\`${target}\``)
        : lines[index].replace(/Worker Status:\s*\S+/, `Worker Status: ${target}`);
    } else {
      const current = CV_STATUS_ROW_RE.exec(lines[index])!;
      if (current[2] === target) return;
      lines[index] = lines[index].includes('`')
        ? lines[index].replace(/`[^`]+`/, `\`${target}\``)
        : lines[index].replace(/Current CV Status:\s*\S+/, `Current CV Status: ${target}`);
    }
    changed.push(index);
  };

  // Stage projection.
  const allStageCarried = allTasks.length > 0 && allTasks.every((id) => carriedForwardTaskIds.has(id));
  const someStageCarried = allTasks.length > 0 && allTasks.some((id) => carriedForwardTaskIds.has(id));
  setRow(stageRows.checkbox, 'checkbox', allStageCarried ? 'x' : ' ');
  setRow(stageRows.worker, 'worker', allStageCarried ? 'COMPLETED' : someStageCarried ? 'IN_PROGRESS' : 'NOT_STARTED');
  setRow(stageRows.cv, 'cv', 'NOT_RUN');

  // Per-Slice projections.
  for (const slice of manifest.slices) {
    const rows = sliceRows.get(slice.slice_id);
    if (rows === undefined) continue; // unreachable after validation
    const sliceTasks = Object.keys(manifest.task_scopes ?? {}).filter((id) => id.startsWith(`${slice.slice_id}-`));
    const allCarried = sliceTasks.length > 0 && sliceTasks.every((id) => carriedForwardTaskIds.has(id));
    const someCarried = sliceTasks.length > 0 && sliceTasks.some((id) => carriedForwardTaskIds.has(id));
    setRow(rows.checkbox, 'checkbox', allCarried ? 'x' : ' ');
    setRow(rows.worker, 'worker', allCarried ? 'COMPLETED' : someCarried ? 'IN_PROGRESS' : 'NOT_STARTED');
    setRow(rows.cv, 'cv', 'NOT_RUN');
  }

  // Task checkbox lines (each anchored marker line is directly followed by its
  // own checkbox line — enforced by validation).
  for (const [taskId, markerIndex] of taskMarkers) {
    const target = carriedForwardTaskIds.has(taskId) ? 'x' : ' ';
    const taskLine = TASK_CHECKBOX_LINE_RE.exec(lines[markerIndex + 1])!;
    if (taskLine[1] !== target) {
      lines[markerIndex + 1] = lines[markerIndex + 1].replace(/\[[ xX]\]/, `[${target}]`);
      changed.push(markerIndex + 1);
    }
  }

  if (changed.length === 0) return tasksMd;
  return lines.join('\n');
}

/**
 * S15-A-T02 — apply the bounded projection restore with a root-bound CAS swap
 * (content compare + temp-write + fsync + atomic rename; a concurrent change
 * fails closed).  Idempotent: an already-restored projection is left as-is.
 */
function restorePlanProjection(
  root: string,
  manifest: VNextManifest,
  carriedForwardTaskIds: ReadonlySet<string>,
): { ok: true; restored: boolean } | { ok: false; message: string } {
  let current: string;
  try {
    current = readRootBoundFile(root, manifest.plan.ref).content;
  } catch (error) {
    return { ok: false, message: `Plan projection cannot be read: ${errorMessage(error)}` };
  }
  const restored = renderRestoredPlanProjection(current, carriedForwardTaskIds, manifest);
  if (restored === null) {
    return { ok: false, message: 'Plan projection is malformed: a Task entity marker without its checkbox line, or a Slice without its `- checkbox:` projection row' };
  }
  if (restored === current) return { ok: true, restored: false };
  const swapped = swapPlanProjection(root, manifest, current, restored);
  if (!swapped.ok) return { ok: false, message: swapped.message };
  return { ok: true, restored: true };
}

/**
 * S15-A-T02 — root-bound CAS swap of the bounded Plan projection (tasks.md).
 * Shared by the rotate (restore) and the recover/rollback projection steps of
 * the journaled stage transaction.
 */
function swapPlanProjection(
  root: string,
  manifest: VNextManifest,
  expected: string,
  replacement: string,
): { ok: true } | { ok: false; message: string } {
  const planDir = path.posix.dirname(manifest.plan.ref);
  let verified: { physicalPath: string; dev: number; ino: number };
  try {
    verified = ensureDirectoryNoFollow(root, planDir);
  } catch (error) {
    return { ok: false, message: `Plan projection directory cannot be opened: ${errorMessage(error)}` };
  }
  let opened: ReturnType<typeof openVerifiedDirectory>;
  try {
    opened = openVerifiedDirectory(verified);
  } catch (error) {
    return { ok: false, message: `Plan projection directory changed: ${errorMessage(error)}` };
  }
  try {
    const swap = swapEvidenceFile(opened.procPrefix, path.posix.basename(manifest.plan.ref), expected, replacement);
    if (swap.kind === 'compare-mismatch') {
      return { ok: false, message: 'Plan projection changed during the restore (compare-and-swap refused)' };
    }
    if (swap.kind !== 'ok') {
      return { ok: false, message: `Plan projection restore failed: ${swap.message}` };
    }
    return { ok: true };
  } finally {
    try {
      fs.closeSync(opened.dirfd);
    } catch {
      // best effort
    }
  }
}

// ------------------------------------------------------------
// mode=replan rotate preflight + transaction
// ------------------------------------------------------------

interface ReplanSlicePreflight {
  readonly sliceId: string;
  readonly evidencePath: string;
  /** New canonical skeleton rendered from the candidate Manifest. */
  readonly newSkeleton: string;
  /** Skeleton with the carried-forward Task Evidence blocks preserved
   *  byte-for-byte (what the canonical file becomes after the swap). */
  readonly newContent: string;
  readonly oldContent: string;
  /** dev:ino of the old canonical Evidence file (journaled identity). */
  readonly oldIdentity: string;
  readonly archivePath: string;
}

/**
 * S15-A-T02 — ZERO-WRITE full preflight over EVERY declared Slice before any
 * write of the rotate transaction (§8.8): no unrecovered rotation journal,
 * old Evidence root-bound/readable with a binding that matches the
 * disposition's previous digests, new skeleton binding matches the
 * disposition's candidate digests, the append-only history target is free,
 * and every carried-forward Task Evidence block is present in the old
 * Evidence.  The transaction core re-validates every fact at commit time;
 * this preflight is the "any preflight failure ⇒ no-write" guarantee.
 */
function preflightReplanRotation(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  disposition: ReplanDisposition,
): { ok: true; slices: ReplanSlicePreflight[] } | { ok: false; errors: VNextCliError[] } {
  const errors: VNextCliError[] = [];
  const slices: ReplanSlicePreflight[] = [];
  const stageId = manifest.stage_id;

  for (const slice of manifest.slices) {
    const sliceId = slice.slice_id;
    const journalRelative = replanJournalPathOf(slice.evidence_path);
    const journalFile = resolveRootBoundPath(root, journalRelative, 'replan journal');
    if (fs.existsSync(journalFile)) {
      errors.push(
        vnextError(
          'UNRECOVERED_TRANSACTION',
          `an unrecovered rotation journal exists for slice "${sliceId}"; run mode=replan recover/rollback before rotating`,
          { path: journalRelative, slice_id: sliceId },
        ),
      );
      continue;
    }

    const opened = openNoFollowRead(root, slice.evidence_path);
    if (!opened.ok) {
      errors.push(
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `old Evidence is missing, a symlink, or unreadable: ${slice.evidence_path}`,
          { path: slice.evidence_path, slice_id: sliceId },
        ),
      );
      continue;
    }
    let oldContent: string;
    let oldIdentity: string;
    try {
      oldContent = fs.readFileSync(opened.fd, 'utf8');
      const stat = fs.fstatSync(opened.fd);
      oldIdentity = `${stat.dev}:${stat.ino}`;
    } catch (error) {
      errors.push(
        vnextError('REPLAN_PREFLIGHT_FAILED', `old Evidence cannot be read: ${errorMessage(error)}`, {
          path: slice.evidence_path,
          slice_id: sliceId,
        }),
      );
      continue;
    } finally {
      try {
        fs.closeSync(opened.fd);
      } catch {
        // best effort
      }
    }

    const oldBinding = parseEvidencePlanBinding(oldContent);
    if (
      oldBinding === null ||
      oldBinding.stage_id !== stageId ||
      oldBinding.slice_id !== sliceId ||
      oldBinding.plan_digest !== disposition.previous_plan_digest ||
      oldBinding.manifest_digest !== disposition.previous_manifest_digest
    ) {
      errors.push(
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `old Evidence binding does not match the disposition previous digests (stage/slice/plan_ref must bind and Plan/Manifest digest must equal disposition.previous_*)`,
          { path: slice.evidence_path, slice_id: sliceId },
        ),
      );
      continue;
    }

    const newSkeleton = renderVNextEvidenceSkeleton(manifest, slice, manifestDigest);
    const newBinding = parseEvidencePlanBinding(newSkeleton);
    if (
      newBinding === null ||
      newBinding.stage_id !== stageId ||
      newBinding.slice_id !== sliceId ||
      newBinding.plan_digest !== disposition.plan_digest ||
      newBinding.manifest_digest !== disposition.manifest_digest ||
      newBinding.plan_ref !== oldBinding.plan_ref
    ) {
      errors.push(
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `new skeleton binding does not match the disposition candidate digests (slice "${sliceId}")`,
          { path: slice.evidence_path, slice_id: sliceId },
        ),
      );
      continue;
    }

    // Append-only history target must be free (CAS on history, §8.8).
    const archivePath = replanArchivePathOf(stageId, disposition.parent_epoch_digest, sliceId);
    const archiveFile = resolveRootBoundPath(root, archivePath, 'history target');
    if (fs.existsSync(archiveFile)) {
      errors.push(
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `append-only history target already exists; refusing to overwrite history: ${archivePath}`,
          { path: archivePath, slice_id: sliceId },
        ),
      );
      continue;
    }

    // Every carried-forward Task of this Slice must have its Task Evidence
    // block in the old Evidence (the rotation preserves it byte-for-byte).
    const carriedBlocks: string[] = [];
    for (const taskId of disposition.carry_forward_task_ids) {
      if (!taskId.startsWith(`${sliceId}-`)) continue;
      const block = extractTaskEvidenceBlock(oldContent, taskId);
      if (block === null) {
        errors.push(
          vnextError(
            'REPLAN_PREFLIGHT_FAILED',
            `carry-forward Task ${taskId} has no Task Evidence block in the old Evidence`,
            { path: slice.evidence_path, slice_id: sliceId },
          ),
        );
        continue;
      }
      carriedBlocks.push(block);
    }
    slices.push({
      sliceId,
      evidencePath: slice.evidence_path,
      newSkeleton,
      newContent: buildReplanRotatedContent(newSkeleton, carriedBlocks),
      oldContent,
      oldIdentity,
      archivePath,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, slices };
}

/**
 * Extract the `### <task-id>` Task Evidence block from old Evidence content
 * (a block runs from its `### <task-id>` heading to the next `### `/`## `
 * heading or EOF).  Mirrors the rotation-core extraction so the preserved
 * blocks are byte-for-byte identical to the archived facts.
 */
export function extractTaskEvidenceBlock(content: string, taskId: string): string | null {
  const header = `### ${taskId}`;
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > start && (line.startsWith('### ') || line.startsWith('## '))) break;
    block.push(line);
  }
  return block.join('\n');
}

/**
 * Build the new canonical content: the skeleton with the `## Task Evidence`
 * placeholder replaced by the preserved carry-forward Task Evidence blocks
 * (byte-for-byte) plus the placeholder for invalidated Tasks.  Mirrors the
 * rotation-core content builder (§8.8 carry-forward preservation).
 */
export function buildReplanRotatedContent(newSkeleton: string, carriedBlocks: readonly string[]): string {
  if (carriedBlocks.length === 0) return newSkeleton;
  const sectionHeader = '## Task Evidence';
  const lines = newSkeleton.split('\n');
  const start = lines.findIndex((line) => line.trim() === sectionHeader);
  if (start === -1) return newSkeleton;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, start + 1);
  const tail = lines.slice(end);
  const placeholderLine = lines.slice(start + 1, end).find((line) => line.trim() === '*Not yet captured.*');
  const body = [...carriedBlocks];
  if (placeholderLine !== undefined) {
    body.push(placeholderLine.trim());
  }
  return [...head, ...body, ...tail].join('\n');
}

/** Root-relative rotation journal path of one Slice Evidence directory. */
function replanJournalPathOf(evidencePath: string): string {
  return `${path.posix.dirname(evidencePath)}/${REPLAN_JOURNAL_FILE}`;
}

// ============================================================
// S15-A-T02 (CV 059af118) — stage-level rotation transaction
// ============================================================

/**
 * The stage-level rotation journal (superset of the rotation-core journal
 * schema).  Every journal carries the projection snapshot so ANY journal of
 * the stage transaction can drive the bounded tasks.md recovery step
 * (idempotent restore for recover, revert for rollback).
 */
interface ReplanRotationJournalSliceEntry {
  readonly slice_id: string;
  readonly evidence_path: string;
  readonly archive_path: string;
  readonly old_content: string;
  readonly new_content: string;
  readonly old_identity: string;
}

/**
 * The stage-level rotation journal (superset of the rotation-core journal
 * schema). Every journal carries the projection snapshot so ANY journal of
 * the stage transaction can drive the bounded tasks.md recovery step
 * (idempotent restore for recover, revert for rollback).
 */
interface ReplanRotationJournal {
  readonly version: 1;
  readonly stage_id: string;
  readonly disposition_digest: string;
  readonly projection_path: string;
  readonly projection_old_content: string;
  readonly projection_new_content: string;
  // single-slice fields (backwards-compatible with fixtures/legacy journals):
  readonly slice_id?: string;
  readonly evidence_path?: string;
  readonly archive_path?: string;
  readonly old_content?: string;
  readonly new_content?: string;
  readonly old_identity?: string;
  // multi-slice entries:
  readonly slices?: readonly ReplanRotationJournalSliceEntry[];
}

/** No-replace atomic install inside a verified directory (temp + fsync +
 *  hard link; `linkSync` never overwrites an existing target). */
function replanInstallNoReplace(
  procPrefix: string,
  fileName: string,
  content: string,
): { ok: true } | { ok: false; message: string } {
  if (fileName.length === 0 || fileName.includes('/') || fileName.includes('\\') || fileName === '.' || fileName === '..') {
    return { ok: false, message: `invalid file name "${fileName}"` };
  }
  const target = `${procPrefix}/${fileName}`;
  const tempName = `.${fileName}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const temp = `${procPrefix}/${tempName}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error('short write during atomic install');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, message: 'target already exists (CAS no-replace) — refusing to overwrite' };
      }
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `atomic install failed: ${errorMessage(error)}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best effort; the target is already a complete hard link if linked
    }
  }
}

/** Read a root-relative canonical file no-follow; capture content + dev:ino. */
function replanReadCanonical(root: string, relativePath: string): { content: string; identity: string } | null {
  const opened = openNoFollowRead(root, relativePath);
  if (!opened.ok) return null;
  try {
    const content = fs.readFileSync(opened.fd, 'utf8');
    const stat = fs.fstatSync(opened.fd);
    return { content, identity: `${stat.dev}:${stat.ino}` };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      // best effort
    }
  }
}

/** Parse + validate the full seam journal shape (fail closed on any drift). */
function readReplanRotationJournal(root: string, journalRelative: string): ReplanRotationJournal | null {
  const journalFile = resolveRootBoundPath(root, journalRelative, 'replan journal');
  let raw: string;
  try {
    raw = fs.readFileSync(journalFile, 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const commonFields: ReadonlyArray<keyof ReplanRotationJournal> = [
    'stage_id',
    'disposition_digest',
    'projection_path',
    'projection_old_content',
    'projection_new_content',
  ];
  for (const field of commonFields) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) return null;
  }

  if (Array.isArray(record.slices)) {
    if (record.slices.length === 0) return null;
    const sliceFields: ReadonlyArray<keyof ReplanRotationJournalSliceEntry> = [
      'slice_id',
      'evidence_path',
      'archive_path',
      'old_content',
      'new_content',
      'old_identity',
    ];
    const parsedSlices: ReplanRotationJournalSliceEntry[] = [];
    for (const item of record.slices) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
      const itemRecord = item as Record<string, unknown>;
      for (const field of sliceFields) {
        if (typeof itemRecord[field] !== 'string' || (itemRecord[field] as string).length === 0) return null;
      }
      parsedSlices.push({
        slice_id: itemRecord.slice_id as string,
        evidence_path: itemRecord.evidence_path as string,
        archive_path: itemRecord.archive_path as string,
        old_content: itemRecord.old_content as string,
        new_content: itemRecord.new_content as string,
        old_identity: itemRecord.old_identity as string,
      });
    }
    return {
      version: 1,
      stage_id: record.stage_id as string,
      disposition_digest: record.disposition_digest as string,
      projection_path: record.projection_path as string,
      projection_old_content: record.projection_old_content as string,
      projection_new_content: record.projection_new_content as string,
      slices: parsedSlices,
    };
  }

  // Single-slice fallback:
  const singleFields: ReadonlyArray<keyof ReplanRotationJournalSliceEntry> = [
    'slice_id',
    'evidence_path',
    'archive_path',
    'old_content',
    'new_content',
    'old_identity',
  ];
  for (const field of singleFields) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) return null;
  }
  const singleSlice: ReplanRotationJournalSliceEntry = {
    slice_id: record.slice_id as string,
    evidence_path: record.evidence_path as string,
    archive_path: record.archive_path as string,
    old_content: record.old_content as string,
    new_content: record.new_content as string,
    old_identity: record.old_identity as string,
  };
  return {
    version: 1,
    stage_id: record.stage_id as string,
    slice_id: record.slice_id as string,
    disposition_digest: record.disposition_digest as string,
    evidence_path: record.evidence_path as string,
    archive_path: record.archive_path as string,
    old_content: record.old_content as string,
    new_content: record.new_content as string,
    old_identity: record.old_identity as string,
    projection_path: record.projection_path as string,
    projection_old_content: record.projection_old_content as string,
    projection_new_content: record.projection_new_content as string,
    slices: [singleSlice],
  };
}

/**
 * S15-A-T02 — PREPARE phase of the stage-level rotation transaction: write
 * the rotation journal of EVERY Slice (with the projection snapshot) BEFORE
 * any mutation. A prepare failure rolls the written journals back
 * in-process; journals that cannot be cleaned up remain for recover/rollback
 * (blocked_recovery).
 */
function prepareReplanRotation(
  root: string,
  manifest: VNextManifest,
  disposition: ReplanDisposition,
  slices: ReplanSlicePreflight[],
): { ok: true } | { ok: false; errors: VNextCliError[]; journalsLeft: boolean } {
  const stageId = manifest.stage_id;
  const dispositionDigest = computeReplanDispositionDigest(disposition);
  const carried = new Set(disposition.carry_forward_task_ids);

  // Projection snapshot: computed ONCE and journaled with every Slice so any
  // journal can drive the projection recovery step.
  let projectionOld: string;
  try {
    projectionOld = readRootBoundFile(root, manifest.plan.ref).content;
  } catch (error) {
    return { ok: false, errors: [vnextError('REPLAN_PREFLIGHT_FAILED', `Plan projection cannot be read: ${errorMessage(error)}`)], journalsLeft: false };
  }
  const rendered = renderRestoredPlanProjection(projectionOld, carried, manifest);
  if (rendered === null) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          'Plan projection is malformed: a Task entity marker without its checkbox line, or a Slice without its `- checkbox:` projection row',
        ),
      ],
      journalsLeft: false,
    };
  }
  const projectionNew = rendered;

  // Group preflighted slices by their evidence directory so each directory
  // receives exactly ONE journal file containing all its slice entries.
  const slicesByDir = new Map<string, ReplanSlicePreflight[]>();
  for (const slice of slices) {
    const dir = path.posix.dirname(slice.evidencePath);
    let list = slicesByDir.get(dir);
    if (!list) {
      list = [];
      slicesByDir.set(dir, list);
    }
    list.push(slice);
  }

  const written: string[] = [];
  for (const [dir, dirSlices] of slicesByDir.entries()) {
    const journalSlices: ReplanRotationJournalSliceEntry[] = dirSlices.map((slice) => ({
      slice_id: slice.sliceId,
      evidence_path: slice.evidencePath,
      archive_path: slice.archivePath,
      old_content: slice.oldContent,
      new_content: slice.newContent,
      old_identity: slice.oldIdentity,
    }));

    let journal: ReplanRotationJournal;
    if (dirSlices.length === 1) {
      const single = dirSlices[0];
      journal = {
        version: 1,
        stage_id: stageId,
        slice_id: single.sliceId,
        disposition_digest: dispositionDigest,
        evidence_path: single.evidencePath,
        archive_path: single.archivePath,
        old_content: single.oldContent,
        new_content: single.newContent,
        old_identity: single.oldIdentity,
        projection_path: manifest.plan.ref,
        projection_old_content: projectionOld,
        projection_new_content: projectionNew,
        slices: journalSlices,
      };
    } else {
      journal = {
        version: 1,
        stage_id: stageId,
        disposition_digest: dispositionDigest,
        projection_path: manifest.plan.ref,
        projection_old_content: projectionOld,
        projection_new_content: projectionNew,
        slices: journalSlices,
      };
    }

    const journalRelative = `${dir}/${REPLAN_JOURNAL_FILE}`;
    try {
      const verified = ensureDirectoryNoFollow(root, dir);
      const opened = openVerifiedDirectory(verified);
      try {
        const install = replanInstallNoReplace(opened.procPrefix, REPLAN_JOURNAL_FILE, JSON.stringify(journal, null, 2));
        if (!install.ok) {
          for (const writtenFile of written) {
            try { fs.unlinkSync(writtenFile); } catch {}
          }
          return {
            ok: false,
            errors: [
              vnextError(
                REPLAN_EVIDENCE_ROTATION_BLOCKED,
                `cannot install rotation journal for evidence directory "${dir}": ${install.message}`,
              ),
            ],
            journalsLeft: false,
          };
        }
      } finally {
        try {
          fs.closeSync(opened.dirfd);
        } catch {
          // best effort
        }
      }
    } catch (error) {
      for (const writtenFile of written) {
        try { fs.unlinkSync(writtenFile); } catch {}
      }
      return {
        ok: false,
        errors: [
          vnextError(
            REPLAN_EVIDENCE_ROTATION_BLOCKED,
            `rotation journal cannot be installed for evidence directory "${dir}": ${errorMessage(error)}`,
          ),
        ],
        journalsLeft: false,
      };
    }
    written.push(resolveRootBoundPath(root, journalRelative, 'replan journal'));
  }
  return { ok: true };
}

/**
 * S15-A-T02 — COMMIT phase: archive (CAS no-replace) + canonical swap (CAS)
 * of EVERY Slice. The journals are KEPT until every Slice committed, so a
 * later-Slice/CAS/identity/journal failure leaves the whole transaction
 * recoverable (complete) or rollback-able (revert) — never partial.
 */
function commitReplanRotation(
  root: string,
  manifest: VNextManifest,
  disposition: ReplanDisposition,
  slices: ReplanSlicePreflight[],
): { ok: true; archivePaths: string[] } | { ok: false; errors: VNextCliError[] } {
  const stageId = manifest.stage_id;
  const archivePaths: string[] = [];
  for (const slice of slices) {
    const historyDir = path.posix.dirname(slice.archivePath);
    try {
      const historyVerified = ensureDirectoryNoFollow(root, historyDir);
      const historyOpen = openVerifiedDirectory(historyVerified);
      try {
        const write = replanInstallNoReplace(historyOpen.procPrefix, `${slice.sliceId}.md`, slice.oldContent);
        if (!write.ok) {
          return {
            ok: false,
            errors: [
              vnextError(
                REPLAN_EVIDENCE_ROTATION_BLOCKED,
                `cannot archive old Evidence of slice ${slice.sliceId}: ${write.message}`,
                { slice_id: slice.sliceId },
              ),
            ],
          };
        }
      } finally {
        try {
          fs.closeSync(historyOpen.dirfd);
        } catch {
          // best effort
        }
      }
    } catch (error) {
      return {
        ok: false,
        errors: [
          vnextError(
            REPLAN_EVIDENCE_ROTATION_BLOCKED,
            `cannot archive old Evidence of slice ${slice.sliceId}: ${errorMessage(error)}`,
            { slice_id: slice.sliceId },
          ),
        ],
      };
    }
    try {
      const evidenceVerified = ensureDirectoryNoFollow(root, path.posix.dirname(slice.evidencePath));
      const evidenceOpen = openVerifiedDirectory(evidenceVerified);
      try {
        const swap = swapEvidenceFile(evidenceOpen.procPrefix, path.posix.basename(slice.evidencePath), slice.oldContent, slice.newContent);
        if (swap.kind === 'compare-mismatch') {
          return {
            ok: false,
            errors: [
              vnextError(
                REPLAN_EVIDENCE_ROTATION_BLOCKED,
                `canonical Evidence of slice ${slice.sliceId} changed during the rotation (compare-and-swap refused)`,
                { slice_id: slice.sliceId },
              ),
            ],
          };
        }
        if (swap.kind !== 'ok') {
          return {
            ok: false,
            errors: [
              vnextError(
                REPLAN_EVIDENCE_ROTATION_BLOCKED,
                `cannot swap canonical Evidence of slice ${slice.sliceId}: ${swap.message}`,
                { slice_id: slice.sliceId },
              ),
            ],
          };
        }
      } finally {
        try {
          fs.closeSync(evidenceOpen.dirfd);
        } catch {
          // best effort
        }
      }
    } catch (error) {
      return {
        ok: false,
        errors: [
          vnextError(
            REPLAN_EVIDENCE_ROTATION_BLOCKED,
            `cannot swap canonical Evidence of slice ${slice.sliceId}: ${errorMessage(error)}`,
            { slice_id: slice.sliceId },
          ),
        ],
      };
    }
    archivePaths.push(slice.archivePath);
  }
  return { ok: true, archivePaths };
}

/** S15-A-T02 — FINALIZE phase: remove every journal only after the full
 *  commit; a removal failure keeps the journals (recoverable). */
function finalizeReplanRotation(
  root: string,
  manifest: VNextManifest,
  slices: ReplanSlicePreflight[],
): { ok: true } | { ok: false; errors: VNextCliError[] } {
  const errors: VNextCliError[] = [];
  const seenDirs = new Set<string>();
  for (const slice of slices) {
    const dir = path.posix.dirname(slice.evidencePath);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const journalRelative = `${dir}/${REPLAN_JOURNAL_FILE}`;
    try {
      fs.unlinkSync(resolveRootBoundPath(root, journalRelative, 'replan journal'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(
          vnextError(
            REPLAN_EVIDENCE_ROTATION_BLOCKED,
            `rotation journal removal failed for evidence directory ${dir}: ${errorMessage(error)}`,
          ),
        );
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * S15-A-T02 — projection step of recover/rollback: restore (recover) or
 * revert (rollback) the bounded tasks.md projection through the journaled
 * snapshot. Idempotent: an already-restored/reverted projection is a no-op;
 * a projection matching NEITHER journaled content fails closed.
 */
function applyReplanProjectionRecovery(
  root: string,
  manifest: VNextManifest,
  journal: ReplanRotationJournal,
  phase: 'recover' | 'rollback',
  expectedProjectionNew: string,
): { ok: true; applied: boolean } | { ok: false; message: string } {
  let current: string;
  try {
    current = readRootBoundFile(root, manifest.plan.ref).content;
  } catch (error) {
    return { ok: false, message: `Plan projection cannot be read: ${errorMessage(error)}` };
  }
  if (phase === 'recover') {
    if (current === expectedProjectionNew) return { ok: true, applied: false };
    if (current !== journal.projection_old_content) {
      return { ok: false, message: 'Plan projection matches neither the journaled old nor restored content' };
    }
    const swapped = swapPlanProjection(root, manifest, journal.projection_old_content, expectedProjectionNew);
    if (!swapped.ok) return { ok: false, message: swapped.message };
    return { ok: true, applied: true };
  }
  if (current === journal.projection_old_content) return { ok: true, applied: false };
  if (current !== expectedProjectionNew && current !== journal.projection_new_content) {
    return { ok: false, message: 'Plan projection matches neither the journaled restored nor original content' };
  }
  const swapped = swapPlanProjection(root, manifest, current, journal.projection_old_content);
  if (!swapped.ok) return { ok: false, message: swapped.message };
  return { ok: true, applied: true };
}

/** After a rollback removes an archived copy, drop now-empty history dirs. */
function replanRemoveEmptyHistoryDirs(root: string, archiveRelative: string): void {
  const epochDir = path.posix.dirname(archiveRelative);
  const historyDir = path.posix.dirname(epochDir);
  for (const dir of [epochDir, historyDir]) {
    try {
      const canonical = canonicalPathWithinRoot(root, dir);
      if (canonical === null) continue;
      fs.rmdirSync(canonical);
    } catch {
      // Directory is not empty or already gone; leave it.
    }
  }
}

/**
 * S15-A-T02 (CV 059af118) — complete (recover) or revert (rollback) ONE
 * journaled per-Slice rotation entry. The commit writes the archive before the
 * canonical swap, so an interrupted stage transaction can stop in any of the
 * four states: (old, !archive) / (old, archive) / (new, archive) /
 * (new, !archive). Every state is either completed forward or reverted; any
 * other state fails closed (matches neither journaled content).
 */
function completeOrRevertReplanJournalEntry(
  root: string,
  entry: ReplanRotationJournalSliceEntry,
  phase: 'recover' | 'rollback',
  expectedNewContent: string,
): { ok: true; archive_path: string } | { ok: false; message: string; blocked: boolean } {
  const archiveFile = resolveRootBoundPath(root, entry.archive_path, 'archive-target');
  const current = replanReadCanonical(root, entry.evidence_path);
  if (current === null) {
    return { ok: false, message: 'canonical Evidence is missing, a symlink, or unreadable', blocked: true };
  }
  const archiveExists = fs.existsSync(archiveFile);
  const oldContent = entry.old_content;
  const newContent = expectedNewContent;
  const evidenceDir = path.posix.dirname(entry.evidence_path);

  const installArchive = (): { ok: true } | { ok: false; message: string } => {
    const historyDir = path.posix.dirname(entry.archive_path);
    try {
      const verified = ensureDirectoryNoFollow(root, historyDir);
      const opened = openVerifiedDirectory(verified);
      try {
        return replanInstallNoReplace(opened.procPrefix, `${entry.slice_id}.md`, oldContent);
      } finally {
        try {
          fs.closeSync(opened.dirfd);
        } catch {
          // best effort
        }
      }
    } catch (error) {
      return { ok: false, message: `cannot archive old Evidence: ${errorMessage(error)}` };
    }
  };

  const swapCanonical = (expected: string, replacement: string): { ok: true } | { ok: false; message: string } => {
    try {
      const verified = ensureDirectoryNoFollow(root, evidenceDir);
      const opened = openVerifiedDirectory(verified);
      try {
        const swap = swapEvidenceFile(opened.procPrefix, path.posix.basename(entry.evidence_path), expected, replacement);
        if (swap.kind === 'compare-mismatch') {
          return { ok: false, message: 'canonical Evidence changed during the recovery (compare-and-swap refused)' };
        }
        if (swap.kind !== 'ok') {
          return { ok: false, message: `canonical Evidence swap failed: ${swap.message}` };
        }
        return { ok: true };
      } finally {
        try {
          fs.closeSync(opened.dirfd);
        } catch {
          // best effort
        }
      }
    } catch (error) {
      return { ok: false, message: `canonical Evidence swap failed: ${errorMessage(error)}` };
    }
  };

  if (current.content === oldContent && !archiveExists) {
    if (phase === 'recover') {
      const archived = installArchive();
      if (!archived.ok) return { ok: false, message: archived.message, blocked: true };
      const swapped = swapCanonical(oldContent, newContent);
      if (!swapped.ok) return { ok: false, message: swapped.message, blocked: true };
      return { ok: true, archive_path: entry.archive_path };
    }
    return { ok: true, archive_path: '' };
  }
  if (current.content === oldContent && archiveExists) {
    if (phase === 'recover') {
      const swapped = swapCanonical(oldContent, newContent);
      if (!swapped.ok) return { ok: false, message: swapped.message, blocked: true };
      return { ok: true, archive_path: entry.archive_path };
    }
    try {
      fs.unlinkSync(archiveFile);
    } catch (error) {
      return { ok: false, message: `archive removal failed: ${errorMessage(error)}`, blocked: true };
    }
    replanRemoveEmptyHistoryDirs(root, entry.archive_path);
    return { ok: true, archive_path: '' };
  }
  if (current.content === newContent && !archiveExists) {
    if (phase === 'recover') {
      const archived = installArchive();
      if (!archived.ok) return { ok: false, message: archived.message, blocked: true };
      return { ok: true, archive_path: entry.archive_path };
    }
    const swapped = swapCanonical(newContent, oldContent);
    if (!swapped.ok) return { ok: false, message: swapped.message, blocked: true };
    return { ok: true, archive_path: '' };
  }
  if (current.content === newContent && archiveExists) {
    if (phase === 'recover') {
      return { ok: true, archive_path: entry.archive_path };
    }
    const swapped = swapCanonical(newContent, oldContent);
    if (!swapped.ok) return { ok: false, message: swapped.message, blocked: true };
    try {
      fs.unlinkSync(archiveFile);
    } catch (error) {
      return { ok: false, message: `archive removal failed: ${errorMessage(error)}`, blocked: true };
    }
    replanRemoveEmptyHistoryDirs(root, entry.archive_path);
    return { ok: true, archive_path: '' };
  }
  return { ok: false, message: 'current canonical state matches neither the journaled old nor new content', blocked: true };
}

/**
 * S15-A-T02 (CV 059af118) — mode=replan rotate transaction (stage-level
 * atomicity):
 *   1. verify the Runtime preparation fact bindings through the admission/
 *      impact oracle + Receipt-derived completion facts (shared preflight);
 *   2. ZERO-WRITE per-Slice preflight of the whole Stage;
 *   3. PREPARE — journal EVERY Slice (projection snapshot journaled too);
 *   4. bounded mutable projection restore (idempotent CAS);
 *   5. COMMIT — archive + canonical swap of EVERY Slice (journals stay);
 *   6. FINALIZE — remove every journal only after the full commit.
 *   Success only when EVERY declared Slice rotated; any later-Slice/CAS/
 *   identity/journal failure leaves the whole transaction recoverable or
 *   rollback-able through the journals — never partial state.
 */
/**
 * S15-A-T02 (repair-18) — verify if a replan rotation has already completed
 * under the current verified disposition. When a rotation completed at an earlier
 * HEAD, and subsequent commit advanced HEAD to include the rotated Evidence/Plan,
 * the rotate phase treats the proven completed state as an idempotent no-op.
 *
 * Strict fail-closed verification requires ALL of the following:
 * 1. No replan journal exists for any slice.
 * 2. The history archive directory for the parent epoch exists and contains ONLY
 *    the exact expected archive files for all declared slices (no foreign/extra files).
 * 3. For each declared slice:
 *    - The archive file exists, parses to the previous plan/manifest digests, and contains
 *      the byte-for-byte carry-forward Task Evidence blocks.
 *    - The canonical Evidence file exists (regular file), parses to the candidate
 *      plan/manifest digests, and matches EXACTLY the rotated content derived from the
 *      candidate skeleton and archive carry-forward blocks.
 * 4. The current Plan projection is structurally valid and matches the restored candidate
 *    projection.
 * Any missing file, digest mismatch, content mismatch, foreign archive, or malformed
 * structure returns { ok: false } and allows the caller to proceed to normal preflight
 * (which will fail closed if corrupted).
 */
function verifyAlreadyCompletedReplanRotation(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  disposition: ReplanDisposition,
): { ok: true; archivePaths: readonly string[] } | { ok: false } {
  const stageId = manifest.stage_id;

  // 1. No replan journal exists
  for (const slice of manifest.slices) {
    const journalRelative = replanJournalPathOf(slice.evidence_path);
    const journalFile = resolveRootBoundPath(root, journalRelative, 'replan journal');
    if (fs.existsSync(journalFile)) {
      return { ok: false };
    }
  }

  // 2. History archive directory exists and contains exactly declared slice archives
  const historyDirRel = `delivery/stages/${stageId}/evidence/history/${disposition.parent_epoch_digest}`;
  const historyDirCanonical = canonicalPathWithinRoot(root, historyDirRel);
  if (historyDirCanonical === null || !fs.existsSync(historyDirCanonical) || !fs.statSync(historyDirCanonical).isDirectory()) {
    return { ok: false };
  }
  const archiveEntries = fs.readdirSync(historyDirCanonical);
  const expectedArchiveFileNames = new Set(manifest.slices.map((s) => `${s.slice_id}.md`));
  if (archiveEntries.length !== manifest.slices.length) {
    return { ok: false };
  }
  for (const entry of archiveEntries) {
    if (!expectedArchiveFileNames.has(entry)) {
      return { ok: false };
    }
  }

  // 3. For each declared slice, verify archive and current Evidence
  const archivePaths: string[] = [];
  for (const slice of manifest.slices) {
    const sliceId = slice.slice_id;
    const archivePath = replanArchivePathOf(stageId, disposition.parent_epoch_digest, sliceId);
    const archiveFile = resolveRootBoundPath(root, archivePath, 'history archive');
    if (!fs.existsSync(archiveFile)) {
      return { ok: false };
    }

    let archiveContent: string;
    try {
      archiveContent = fs.readFileSync(archiveFile, 'utf8');
    } catch {
      return { ok: false };
    }

    const archiveBinding = parseEvidencePlanBinding(archiveContent);
    if (
      archiveBinding === null ||
      archiveBinding.stage_id !== stageId ||
      archiveBinding.slice_id !== sliceId ||
      archiveBinding.plan_digest !== disposition.previous_plan_digest ||
      archiveBinding.manifest_digest !== disposition.previous_manifest_digest ||
      archiveBinding.plan_ref !== manifest.plan.ref
    ) {
      return { ok: false };
    }

    // Verify current canonical Evidence
    const opened = openNoFollowRead(root, slice.evidence_path);
    if (!opened.ok) {
      return { ok: false };
    }
    let currentContent: string;
    try {
      currentContent = fs.readFileSync(opened.fd, 'utf8');
    } catch {
      return { ok: false };
    } finally {
      try {
        fs.closeSync(opened.fd);
      } catch {
        // ignore
      }
    }

    const currentBinding = parseEvidencePlanBinding(currentContent);
    if (
      currentBinding === null ||
      currentBinding.stage_id !== stageId ||
      currentBinding.slice_id !== sliceId ||
      currentBinding.plan_digest !== disposition.plan_digest ||
      currentBinding.manifest_digest !== disposition.manifest_digest ||
      currentBinding.plan_ref !== manifest.plan.ref
    ) {
      return { ok: false };
    }

    // Verify carry-forward blocks from archive match current evidence exactly
    const newSkeleton = renderVNextEvidenceSkeleton(manifest, slice, manifestDigest);
    const carriedBlocks: string[] = [];
    for (const taskId of disposition.carry_forward_task_ids) {
      if (!taskId.startsWith(`${sliceId}-`)) continue;
      const blockFromArchive = extractTaskEvidenceBlock(archiveContent, taskId);
      if (blockFromArchive === null) {
        return { ok: false };
      }
      carriedBlocks.push(blockFromArchive);
    }

    const expectedRotatedContent = buildReplanRotatedContent(newSkeleton, carriedBlocks);
    if (currentContent !== expectedRotatedContent) {
      return { ok: false };
    }

    archivePaths.push(archivePath);
  }

  // 4. Verify current Plan projection is structurally valid and represents candidate projection
  let currentProjContent: string;
  try {
    currentProjContent = readRootBoundFile(root, manifest.plan.ref).content;
  } catch {
    return { ok: false };
  }

  const projValidation = validatePlanProjectionStructure(currentProjContent, manifest);
  if (!projValidation.ok) {
    return { ok: false };
  }

  const expectedRestored = renderRestoredPlanProjection(
    currentProjContent,
    new Set(disposition.carry_forward_task_ids),
    manifest,
  );
  if (expectedRestored === null || expectedRestored !== currentProjContent) {
    return { ok: false };
  }

  return { ok: true, archivePaths };
}

/**
 * S15-A-T02 (repair-24) — verify strict, explicit HEAD-only idempotent no-op state.
 *
 * For replan_phase rotate, no-op must be ZERO-WRITE and fail closed unless:
 * 1. Every declared Slice has no replan journal.
 * 2. Every declared Slice has a root-bound regular current Evidence file with the candidate
 *    manifest/plan binding.
 * 3. The current Plan projection passes the shared structural validator and is already the
 *    candidate projection.
 *
 * Any missing, forged, foreign, malformed, symlinked, journaled, or binding-mismatched
 * state returns failure with zero writes.
 */
function verifyReplanNoOpState(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  disposition: ReplanDisposition,
): { ok: true } | { ok: false; errors: VNextCliError[] } {
  const stageId = manifest.stage_id;
  const errors: VNextCliError[] = [];

  // 1. Every declared slice must have NO unrecovered replan journal
  for (const slice of manifest.slices) {
    const journalRelative = replanJournalPathOf(slice.evidence_path);
    const journalFile = resolveRootBoundPath(root, journalRelative, 'replan journal');
    if (fs.existsSync(journalFile)) {
      errors.push(
        vnextError(
          'UNRECOVERED_TRANSACTION',
          `an unrecovered rotation journal exists for slice "${slice.slice_id}"; run mode=replan recover/rollback before rotating`,
          { path: journalRelative, slice_id: slice.slice_id },
        ),
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 2. For every declared slice: root-bound regular current Evidence file with candidate manifest/plan binding
  for (const slice of manifest.slices) {
    const sliceId = slice.slice_id;
    const opened = openNoFollowRead(root, slice.evidence_path);
    if (!opened.ok) {
      errors.push(
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `Evidence is missing, a symlink, or unreadable: ${slice.evidence_path}`,
          { path: slice.evidence_path, slice_id: sliceId },
        ),
      );
      continue;
    }

    let currentContent: string;
    try {
      const stat = fs.fstatSync(opened.fd);
      if (!stat.isFile()) {
        errors.push(
          vnextError(
            'REPLAN_PREFLIGHT_FAILED',
            `Evidence is not a regular file: ${slice.evidence_path}`,
            { path: slice.evidence_path, slice_id: sliceId },
          ),
        );
        continue;
      }
      currentContent = fs.readFileSync(opened.fd, 'utf8');
    } catch (error) {
      errors.push(
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `Evidence cannot be read: ${errorMessage(error)}`,
          { path: slice.evidence_path, slice_id: sliceId },
        ),
      );
      continue;
    } finally {
      try {
        fs.closeSync(opened.fd);
      } catch {
        // ignore
      }
    }

    const currentBinding = parseEvidencePlanBinding(currentContent);
    if (
      currentBinding === null ||
      currentBinding.stage_id !== stageId ||
      currentBinding.slice_id !== sliceId ||
      currentBinding.plan_digest !== disposition.plan_digest ||
      currentBinding.manifest_digest !== disposition.manifest_digest ||
      currentBinding.plan_ref !== manifest.plan.ref
    ) {
      errors.push(
        vnextError(
          'REPLAN_BINDING_MISMATCH',
          `Evidence plan binding does not match candidate manifest/plan binding: ${slice.evidence_path}`,
          { path: slice.evidence_path, slice_id: sliceId },
        ),
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 3. Current Plan projection passes the shared structural validator and is already the candidate projection
  let currentProjContent: string;
  try {
    currentProjContent = readRootBoundFile(root, manifest.plan.ref).content;
  } catch (error) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `Plan projection cannot be read: ${errorMessage(error)}`,
          { path: manifest.plan.ref },
        ),
      ],
    };
  }

  const projValidation = validatePlanProjectionStructure(currentProjContent, manifest);
  if (!projValidation.ok) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          `Plan projection structure is invalid: ${projValidation.message}`,
          { path: manifest.plan.ref },
        ),
      ],
    };
  }

  const expectedRestored = renderRestoredPlanProjection(
    currentProjContent,
    new Set(disposition.carry_forward_task_ids),
    manifest,
  );
  if (expectedRestored === null || expectedRestored !== currentProjContent) {
    return {
      ok: false,
      errors: [
        vnextError(
          'REPLAN_PREFLIGHT_FAILED',
          'Plan projection does not match candidate projection',
          { path: manifest.plan.ref },
        ),
      ],
    };
  }

  return { ok: true };
}

function runReplanRotate(
  root: string,
  request: RefreshVNextSliceEvidenceRequest,
  manifest: VNextManifest,
  manifestDigest: string,
): RefreshVNextSliceEvidenceResult {
  const stageId = manifest.stage_id;
  const verified = verifyReplanRotationBindings(root, request, manifest, manifestDigest);
  if (!verified.ok) return replanFailed(stageId, verified.errors);
  const { fact, disposition, parentEpochDigest } = verified;

  // S15-A-T02 (repair-24): Strict HEAD-only idempotent no-op path.
  // When Manifest/Plan contracts are unchanged and all derived sets are empty (HEAD advance
  // without re-rotation), return successful zero-write envelope after validating clean state.
  if (isReplanNoOpDisposition(disposition)) {
    const noOpCheck = verifyReplanNoOpState(root, manifest, manifestDigest, disposition);
    if (!noOpCheck.ok) {
      return replanFailed(stageId, noOpCheck.errors);
    }
    return {
      success: true,
      stage_id: stageId,
      schema_version: VNEXT_SCHEMA_VERSION,
      mode: 'replan',
      refreshed: manifest.slices.map((slice) => slice.evidence_path),
      recovered: false,
      rolled_back: false,
      blocked_recovery: false,
      errors: [],
      replan_phase: 'rotate',
      disposition_digest: fact.digest,
      parent_epoch_digest: parentEpochDigest,
      archive_paths: [],
      projection_restored: true,
    };
  }

  // S15-A-T02 (repair-18): Check if rotation is already completed and proven
  // at the current verified snapshot (idempotent no-op for advanced Git HEAD).
  const alreadyCompleted = verifyAlreadyCompletedReplanRotation(root, manifest, manifestDigest, disposition);
  if (alreadyCompleted.ok) {
    return {
      success: true,
      stage_id: stageId,
      schema_version: VNEXT_SCHEMA_VERSION,
      mode: 'replan',
      refreshed: manifest.slices.map((slice) => slice.evidence_path),
      recovered: false,
      rolled_back: false,
      blocked_recovery: false,
      errors: [],
      replan_phase: 'rotate',
      disposition_digest: fact.digest,
      parent_epoch_digest: parentEpochDigest,
      archive_paths: alreadyCompleted.archivePaths,
      projection_restored: true,
    };
  }

  const preflight = preflightReplanRotation(root, manifest, manifestDigest, disposition);
  if (!preflight.ok) {
    const hasJournal = manifest.slices.some((slice) =>
      fs.existsSync(resolveRootBoundPath(root, replanJournalPathOf(slice.evidence_path), 'replan journal')),
    );
    return replanFailed(stageId, preflight.errors, hasJournal);
  }

  // 1) PREPARE — write the rotation journal of EVERY Slice before any
  // mutation (the projection snapshot is journaled too). A prepare failure
  // rolls the written journals back in-process (zero Evidence/plan writes).
  const prepared = prepareReplanRotation(root, manifest, disposition, preflight.slices);
  if (!prepared.ok) return replanFailed(stageId, prepared.errors, prepared.journalsLeft);

  // 2) PROJECTION restore — bounded CAS swap; part of the journaled
  // transaction (recover re-applies it, rollback reverts it).
  const restored = restorePlanProjection(root, manifest, new Set(disposition.carry_forward_task_ids));
  if (!restored.ok) {
    return replanFailed(stageId, [vnextError('REPLAN_PREFLIGHT_FAILED', restored.message)], true);
  }

  // 3) COMMIT — archive + swap EVERY slice; journals are kept until every
  // slice committed so any later failure leaves a recoverable/rollback-able
  // transaction (no partial state, CV 059af118).
  const committed = commitReplanRotation(root, manifest, disposition, preflight.slices);
  if (!committed.ok) return replanFailed(stageId, committed.errors, true);

  // 4) FINALIZE — remove every journal only after the full commit.
  const finalized = finalizeReplanRotation(root, manifest, preflight.slices);
  if (!finalized.ok) return replanFailed(stageId, finalized.errors, true);

  return {
    success: true,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    mode: 'replan',
    refreshed: preflight.slices.map((slice) => slice.evidencePath),
    recovered: false,
    rolled_back: false,
    blocked_recovery: false,
    errors: [],
    replan_phase: 'rotate',
    disposition_digest: fact.digest,
    parent_epoch_digest: parentEpochDigest,
    archive_paths: committed.archivePaths,
    projection_restored: restored.restored,
  };
}

/**
 * S15-A-T02 (CV 059af118) — mode=replan recover/rollback: completes or
 * reverts the journaled stage rotation transaction (restart recovery from
 * the journal only, §8.8 rotation oracle). The same fact/binding
 * verification (oracle + Receipt-derived completion facts) runs first, so a
 * recovery can never be driven by a stale or forged disposition. Every
 * journal found is bound to the verified disposition, its Slice, its
 * Evidence path and the current Manifest's Plan projection; a journal that
 * fails any binding fails closed. The projection step runs BEFORE the
 * Evidence journals settle, so recover fully restores and rollback fully
 * reverts — projection and Evidence together, never partial.
 */
function runReplanJournalRecovery(
  root: string,
  request: RefreshVNextSliceEvidenceRequest,
  manifest: VNextManifest,
  manifestDigest: string,
  phase: 'recover' | 'rollback',
): RefreshVNextSliceEvidenceResult {
  const stageId = manifest.stage_id;
  const verified = verifyReplanRotationBindings(root, request, manifest, manifestDigest);
  if (!verified.ok) {
    const errors = verified.errors.map((e) =>
      vnextError('UNRECOVERED_TRANSACTION', e.message, { path: e.path, slice_id: e.slice_id }),
    );
    return replanFailed(stageId, errors, true);
  }
  const { fact, disposition, parentEpochDigest } = verified;
  const dispositionDigest = computeReplanDispositionDigest(disposition);

  // Collect the distinct journal files across the declared Evidence
  // directories and bind each to the Slice it records; every binding failure
  // fails closed before any write.
  const foundJournals: Array<{ dir: string; journal: ReplanRotationJournal; entries: readonly ReplanRotationJournalSliceEntry[] }> = [];
  const seenDirs = new Set<string>();
  for (const slice of manifest.slices) {
    const journalRelative = replanJournalPathOf(slice.evidence_path);
    const dir = path.posix.dirname(journalRelative);
    if (seenDirs.has(dir)) continue; // one journal per Evidence directory
    seenDirs.add(dir);
    const journalFile = resolveRootBoundPath(root, journalRelative, 'replan journal');
    if (!fs.existsSync(journalFile)) continue;

    const journal = readReplanRotationJournal(root, journalRelative);
    if (journal === null) {
      return replanFailed(
        stageId,
        [vnextError('UNRECOVERED_TRANSACTION', `rotation journal has an invalid shape: ${journalRelative}`, { path: journalRelative })],
        true,
      );
    }
    if (journal.stage_id !== stageId) {
      return replanFailed(
        stageId,
        [
          vnextError(
            'UNRECOVERED_TRANSACTION',
            `rotation journal belongs to Stage "${journal.stage_id}", not "${stageId}"`,
            { path: journalRelative },
          ),
        ],
        true,
      );
    }
    if (journal.disposition_digest !== dispositionDigest) {
      return replanFailed(
        stageId,
        [
          vnextError(
            'UNRECOVERED_TRANSACTION',
            'rotation journal does not match the verified disposition (stale or forged journal)',
            { path: journalRelative },
          ),
        ],
        true,
      );
    }
    if (journal.projection_path !== manifest.plan.ref) {
      return replanFailed(
        stageId,
        [
          vnextError(
            'UNRECOVERED_TRANSACTION',
            `rotation journal projection_path "${journal.projection_path}" does not match the Manifest Plan projection "${manifest.plan.ref}"`,
            { path: journalRelative },
          ),
        ],
        true,
      );
    }

    const entries = journal.slices ?? [];
    if (entries.length === 0) {
      return replanFailed(
        stageId,
        [vnextError('UNRECOVERED_TRANSACTION', `rotation journal has no slice entries: ${journalRelative}`, { path: journalRelative })],
        true,
      );
    }
    foundJournals.push({ dir, journal, entries });
  }

  if (foundJournals.length === 0) {
    return replanFailed(
      stageId,
      [vnextError('NO_TRANSACTION', `no replan rotation journal exists; nothing to ${phase}`)],
    );
  }

  // 3. Multi-Slice journal coverage & validation
  const allJournalSlices = new Map<string, { dir: string; entry: ReplanRotationJournalSliceEntry }>();
  for (const { dir, entries } of foundJournals) {
    for (const entry of entries) {
      const declared = manifest.slices.find((s) => s.slice_id === entry.slice_id);
      if (!declared) {
        return replanFailed(
          stageId,
          [vnextError('UNRECOVERED_TRANSACTION', `rotation journal records unknown Slice "${entry.slice_id}" not in Manifest`, { path: `${dir}/${REPLAN_JOURNAL_FILE}` })],
          true,
        );
      }
      if (entry.evidence_path !== declared.evidence_path) {
        return replanFailed(
          stageId,
          [vnextError('UNRECOVERED_TRANSACTION', `rotation journal evidence_path "${entry.evidence_path}" does not match declared "${declared.evidence_path}"`, { path: `${dir}/${REPLAN_JOURNAL_FILE}` })],
          true,
        );
      }
      if (path.posix.dirname(entry.evidence_path) !== dir) {
        return replanFailed(
          stageId,
          [vnextError('UNRECOVERED_TRANSACTION', `cross-directory mixed chain: slice "${entry.slice_id}" evidence "${entry.evidence_path}" is not in journal directory "${dir}"`, { path: `${dir}/${REPLAN_JOURNAL_FILE}` })],
          true,
        );
      }
      if (allJournalSlices.has(entry.slice_id)) {
        return replanFailed(
          stageId,
          [vnextError('UNRECOVERED_TRANSACTION', `duplicate slice entry "${entry.slice_id}" across rotation journals`, { path: `${dir}/${REPLAN_JOURNAL_FILE}` })],
          true,
        );
      }
      allJournalSlices.set(entry.slice_id, { dir, entry });
    }
  }

  for (const slice of manifest.slices) {
    if (!allJournalSlices.has(slice.slice_id)) {
      return replanFailed(
        stageId,
        [vnextError('UNRECOVERED_TRANSACTION', `rotation journal set is incomplete; missing declared slice "${slice.slice_id}"`)],
        true,
      );
    }
  }

  // 4. Validate projection consistency across journals
  const first = foundJournals[0].journal;
  for (const { dir, journal } of foundJournals) {
    if (
      journal.projection_old_content !== first.projection_old_content ||
      journal.projection_new_content !== first.projection_new_content
    ) {
      return replanFailed(
        stageId,
        [
          vnextError(
            'UNRECOVERED_TRANSACTION',
            'rotation journals carry inconsistent projection snapshots (mixed transactions)',
            { path: `${dir}/${REPLAN_JOURNAL_FILE}` },
          ),
        ],
        true,
      );
    }
  }

  // Recompute expected projection_new_content from projection_old_content using the
  // Runtime renderer. This is ONLY a consistency cross-check: the journaled
  // projection_old/projection_new contents must FIRST pass the independent
  // structural validation (validatePlanProjectionStructure), so the renderer
  // recompute is never the sole basis for accepting a journal (CV
  // S15-A-REPAIR10-PLAN-MARKER-SECTION-OWNERSHIP-SELF-ORACLE, counterexample 4).
  const oldProjectionValidation = validatePlanProjectionStructure(first.projection_old_content, manifest);
  if (!oldProjectionValidation.ok) {
    return replanFailed(
      stageId,
      [vnextError('UNRECOVERED_TRANSACTION', `rotation journal projection_old_content is structurally invalid: ${oldProjectionValidation.message}`)],
      true,
    );
  }
  const newProjectionValidation = validatePlanProjectionStructure(first.projection_new_content, manifest);
  if (!newProjectionValidation.ok) {
    return replanFailed(
      stageId,
      [vnextError('UNRECOVERED_TRANSACTION', `rotation journal projection_new_content is structurally invalid: ${newProjectionValidation.message}`)],
      true,
    );
  }
  const expectedProjectionNew = renderRestoredPlanProjection(
    first.projection_old_content,
    new Set(disposition.carry_forward_task_ids),
    manifest,
  );
  if (expectedProjectionNew === null) {
    return replanFailed(
      stageId,
      [vnextError('UNRECOVERED_TRANSACTION', 'projection_old_content is malformed; cannot restore projection')],
      true,
    );
  }
  if (first.projection_new_content !== expectedProjectionNew) {
    return replanFailed(
      stageId,
      [vnextError('UNRECOVERED_TRANSACTION', 'rotation journal carries forged or invalid projection_new_content')],
      true,
    );
  }

  // 5. Preflight check all entries AND projection BEFORE ANY WRITE/SWAP (Zero-write guarantee)
  // Check projection
  try {
    const currentProj = readRootBoundFile(root, manifest.plan.ref).content;
    if (currentProj !== first.projection_old_content && currentProj !== expectedProjectionNew) {
      return replanFailed(
        stageId,
        [vnextError('UNRECOVERED_TRANSACTION', `plan projection content changed outside journal transaction: ${manifest.plan.ref}`)],
        true,
      );
    }
  } catch (error) {
    return replanFailed(
      stageId,
      [vnextError('UNRECOVERED_TRANSACTION', `cannot read plan projection: ${errorMessage(error)}`)],
      true,
    );
  }

  const expectedNewContents = new Map<string, string>();

  // Check all slice entries
  for (const { dir, entry } of allJournalSlices.values()) {
    const slice = manifest.slices.find((s) => s.slice_id === entry.slice_id)!;
    if (typeof entry.archive_path !== 'string' || entry.archive_path.length === 0) {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} journal entry has no archive_path`)], true);
    }
    const expectedArchive = replanArchivePathOf(stageId, disposition.parent_epoch_digest, slice.slice_id);
    if (entry.archive_path !== expectedArchive) {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} journal archive_path does not match expected epoch path`)], true);
    }
    const archiveCanonical = canonicalPathWithinRoot(root, entry.archive_path);
    if (archiveCanonical === null) {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} archive_path escapes root: ${entry.archive_path}`)], true);
    }
    if (typeof entry.old_content !== 'string' || typeof entry.new_content !== 'string') {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} journal entry has invalid old/new content`)], true);
    }
    if (typeof entry.old_identity !== 'string' || entry.old_identity.length === 0) {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} journal entry has no old_identity`)], true);
    }

    const oldBinding = parseEvidencePlanBinding(entry.old_content);
    if (
      oldBinding === null ||
      oldBinding.stage_id !== stageId ||
      oldBinding.slice_id !== slice.slice_id ||
      oldBinding.plan_digest !== disposition.previous_plan_digest ||
      oldBinding.manifest_digest !== disposition.previous_manifest_digest
    ) {
      return replanFailed(
        stageId,
        [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} journal old_content binding does not match previous epoch digests`)],
        true,
      );
    }

    // Recompute expected skeleton and new_content
    const expectedSkeleton = renderVNextEvidenceSkeleton(manifest, slice, manifestDigest);
    const carriedBlocks: string[] = [];
    for (const taskId of disposition.carry_forward_task_ids) {
      if (!taskId.startsWith(`${slice.slice_id}-`)) continue;
      const block = extractTaskEvidenceBlock(entry.old_content, taskId);
      if (block === null) {
        return replanFailed(
          stageId,
          [vnextError('UNRECOVERED_TRANSACTION', `carry-forward Task ${taskId} has no Task Evidence block in old_content`)],
          true,
        );
      }
      carriedBlocks.push(block);
    }
    const expectedNewContent = buildReplanRotatedContent(expectedSkeleton, carriedBlocks);
    if (entry.new_content !== expectedNewContent) {
      return replanFailed(
        stageId,
        [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} journal carries forged or invalid new_content`, { path: `${dir}/${REPLAN_JOURNAL_FILE}` })],
        true,
      );
    }
    expectedNewContents.set(entry.slice_id, expectedNewContent);

    const read = replanReadCanonical(root, entry.evidence_path);
    if (read === null) {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} canonical evidence cannot be read: ${entry.evidence_path}`)], true);
    }
    if (read.content !== entry.old_content && read.content !== expectedNewContent) {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} canonical evidence changed outside transaction`)], true);
    }
    if (read.content === entry.old_content && read.identity !== entry.old_identity) {
      return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} canonical evidence file identity changed outside transaction`)], true);
    }
    const archiveFile = resolveRootBoundPath(root, entry.archive_path, 'archive-target');
    if (fs.existsSync(archiveFile)) {
      try {
        const archContent = fs.readFileSync(archiveFile, 'utf8');
        if (archContent !== entry.old_content) {
          return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} archive file exists but does not match journal old_content`)], true);
        }
      } catch (error) {
        return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', `slice ${entry.slice_id} archive file cannot be read: ${errorMessage(error)}`)], true);
      }
    }
  }

  // 6. Projection step FIRST: recover restores, rollback reverts — idempotent
  // CAS; the journals stay until every Slice settles. The journaled
  // projection_new_content (banked and independently validated above) is the
  // authoritative restore target, not a runtime re-render of the current file.
  const projection = applyReplanProjectionRecovery(root, manifest, first, phase, first.projection_new_content);
  if (!projection.ok) {
    return replanFailed(stageId, [vnextError('UNRECOVERED_TRANSACTION', projection.message)], true);
  }

  const refreshed: string[] = [];
  const archivePaths: string[] = [];
  const errors: VNextCliError[] = [];
  let anyJournalLeft = false;

  for (const { dir, entries } of foundJournals) {
    let journalEntriesOk = true;
    for (const entry of entries) {
      const expectedNewContent = expectedNewContents.get(entry.slice_id) ?? entry.new_content;
      const completed = completeOrRevertReplanJournalEntry(root, entry, phase, expectedNewContent);
      if (!completed.ok) {
        errors.push(
          vnextError(REPLAN_EVIDENCE_ROTATION_BLOCKED, `slice ${entry.slice_id}: ${completed.message}`, {
            slice_id: entry.slice_id,
          }),
        );
        journalEntriesOk = false;
        if (completed.blocked) anyJournalLeft = true;
        continue;
      }
      refreshed.push(entry.evidence_path);
      if (completed.archive_path.length > 0) archivePaths.push(completed.archive_path);
    }
    if (journalEntriesOk) {
      try {
        fs.unlinkSync(resolveRootBoundPath(root, `${dir}/${REPLAN_JOURNAL_FILE}`, 'replan journal'));
      } catch (error) {
        errors.push(
          vnextError(
            REPLAN_EVIDENCE_ROTATION_BLOCKED,
            `rotation journal removal failed for evidence directory ${dir}: ${errorMessage(error)}`,
          ),
        );
        anyJournalLeft = true;
      }
    } else {
      anyJournalLeft = true;
    }
  }

  if (errors.length > 0) {
    return replanFailed(stageId, errors, anyJournalLeft);
  }

  return {
    success: true,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    mode: 'replan',
    refreshed,
    recovered: phase === 'recover',
    rolled_back: phase === 'rollback',
    blocked_recovery: false,
    errors: [],
    replan_phase: phase,
    disposition_digest: fact.digest,
    parent_epoch_digest: parentEpochDigest,
    archive_paths: archivePaths,
    projection_restored: phase === 'recover' && projection.applied,
  };
}

/**
 * S15-A-T02 — mode=replan entry.  The operation is post-admission (receipts
 * ARE its precondition — the pre-admission receipt-absence preflight does not
 * apply) and is served entirely by the Runtime-owned disposition fact +
 * epoch chain + rotation core: it never accepts caller-supplied derived sets
 * and never rewrites Receipt/Manifest/CV facts.
 */
function runReplanRefresh(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  request: RefreshVNextSliceEvidenceRequest,
): RefreshVNextSliceEvidenceResult {
  const stageId = manifest.stage_id;
  const phase: ReplanRefreshPhase = request.replanPhase ?? 'rotate';
  if (phase !== 'rotate' && phase !== 'recover' && phase !== 'rollback') {
    return replanFailed(stageId, [
      vnextError('USAGE', `replan_phase must be one of rotate|recover|rollback, got "${String(request.replanPhase)}"`),
    ]);
  }
  if (phase === 'recover' || phase === 'rollback') {
    return runReplanJournalRecovery(root, request, manifest, manifestDigest, phase);
  }
  return runReplanRotate(root, request, manifest, manifestDigest);
}
