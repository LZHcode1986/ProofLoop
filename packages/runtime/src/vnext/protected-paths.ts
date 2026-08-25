/**
 * vNext protected-artifact scan.
 *
 * This seam owns only the ignored protected-path boundary check; finalize-lineage
 * validation and admission-authority readers stay in their canonical modules.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, validateVNextManifest } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { resolveGitRoot } from '../git-source';
import { VNextHandoffError } from './errors';
import { loadAncestorReplanDispositionRecords } from './replan-epoch';
import type { ReplanAncestorDispositionRecord } from './replan-epoch';

export interface VNextIgnoredProtectedPathBinding {
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  readonly contextRef: string;
  readonly mode: 'implement-task' | 'recover-task' | 'finalize-slice';
}

const IGNORED_PROTECTED_SCAN_PATHS = [
  '.proofloop/receipts',
  '.proofloop/manifests',
  '.proofloop/runtime',
  '.proofloop/runtime.lock',
  '.proofloop/context',
] as const;
const RUNTIME_ARTIFACT_FILES = new Set(['gate-result.json', 'reconcile-input.json', 'slice-complete-facts.json']);
const RUNTIME_LOCK_FIELDS = new Set(['runtime_version', 'domain_schema_version', 'risk_policy_version', 'capability_policy_version', 'host_adapter', 'plugin_package', 'plugin_version']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rootRelativeFactPath(root: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.startsWith('//') || value.includes('\\') || value.includes('\u0000')) {
    throw new VNextHandoffError('path-escape', `${label} must be a canonical root-relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new VNextHandoffError('path-escape', `${label} must be a canonical root-relative path`);
  }
  const lexical = path.resolve(root, ...parts);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    throw new VNextHandoffError('path-escape', `${label} escapes or traverses the project root`);
  }
  return parts.join('/');
}

function readRootBoundJson(root: string, relative: string, label: string): unknown {
  const canonicalRelative = rootRelativeFactPath(root, relative, label);
  const opened = openNoFollowRead(root, path.resolve(root, ...canonicalRelative.split('/')));
  if (!opened.ok) throw new VNextHandoffError('path-escape', `${label} is missing or not root-bound`);
  try {
    return JSON.parse(fs.readFileSync(opened.fd, 'utf8')) as unknown;
  } catch (error) {
    throw new VNextHandoffError('admission-invalid', `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.closeSync(opened.fd);
  }
}

function ignoredProtectedMismatch(message: string): never {
  throw new VNextHandoffError('execution-scope-gap', message);
}

function assertIgnoredRuntimeLock(root: string, relative: string): void {
  const value = readRootBoundJson(root, relative, 'ignored Runtime lock');
  if (!isRecord(value)) ignoredProtectedMismatch(`ignored Runtime lock is not a JSON object: ${relative}`);
  const unknown = Object.keys(value).filter((key) => !RUNTIME_LOCK_FIELDS.has(key));
  if (unknown.length > 0) ignoredProtectedMismatch(`ignored Runtime lock contains unknown field(s): ${unknown.join(', ')}`);
  if (typeof value.runtime_version !== 'string' || value.runtime_version.length === 0) ignoredProtectedMismatch(`ignored Runtime lock.runtime_version is invalid: ${relative}`);
  for (const field of ['domain_schema_version', 'risk_policy_version', 'capability_policy_version'] as const) {
    const number = value[field];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) ignoredProtectedMismatch(`ignored Runtime lock.${field} is invalid: ${relative}`);
  }
  for (const field of ['host_adapter', 'plugin_package', 'plugin_version'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) ignoredProtectedMismatch(`ignored Runtime lock.${field} is invalid: ${relative}`);
  }
}

function assertIgnoredRuntimeArtifact(root: string, relative: string): void {
  const replanMatch = /^\.proofloop\/runtime\/replan\/([^/]+)\/([a-f0-9]{64})\.json$/.exec(relative);
  if (replanMatch !== null) {
    const value = readRootBoundJson(root, relative, 'ignored Runtime replan artifact');
    if (!isRecord(value) || value.stage_id !== replanMatch[1]) ignoredProtectedMismatch(`ignored Runtime replan artifact is invalid: ${relative}`);
    return;
  }
  const match = /^\.proofloop\/runtime\/([^/]+)\/([^/]+)$/.exec(relative);
  if (match === null || !RUNTIME_ARTIFACT_FILES.has(match[2])) ignoredProtectedMismatch(`ignored protected path is not an admitted Runtime artifact: ${relative}`);
  const value = readRootBoundJson(root, relative, 'ignored Runtime artifact');
  if (match[2] === 'slice-complete-facts.json') {
    if (!Array.isArray(value)) ignoredProtectedMismatch(`ignored Runtime slice-complete facts must be a JSON array: ${relative}`);
    return;
  }
  if (!isRecord(value) || value.stage_id !== match[1]) ignoredProtectedMismatch(`ignored Runtime artifact is invalid: ${relative}`);
}

/** Scan ignored Runtime artifacts using caller-supplied persisted replan facts. */
export function assertIgnoredProtectedPaths(
  root: string,
  bindings: readonly VNextIgnoredProtectedPathBinding[],
  replanDispositions: readonly ReplanAncestorDispositionRecord[] = [],
): void {
  if (bindings.length === 0) return;
  const effectiveReplanDispositions = replanDispositions.length > 0
    ? replanDispositions
    : loadAncestorReplanDispositionRecords(root, bindings[0].stageId);
  let gitRoot: string;
  try { gitRoot = resolveGitRoot(root); } catch (error) { throw new VNextHandoffError('manifest-binding', `Git ignored protected-path list is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  let output: string;
  try {
    output = execFileSync('git', ['-C', gitRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...IGNORED_PROTECTED_SCAN_PATHS], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new VNextHandoffError('manifest-binding', 'Git ignored protected-path list is unavailable'); }
  const stageId = bindings[0].stageId;
  const currentManifest = `.proofloop/manifests/${stageId}.json`;
  const currentStageHiddenManifestPrefix = `.proofloop/manifests/${stageId}-`;
  const allowedContextRefs = new Set(bindings.map((binding) => binding.contextRef));
  const contextPattern = /^\.proofloop\/context\/[a-f0-9]{64}\.json$/;
  const receiptPattern = /(?:^|\/)(?:[a-f0-9]{64}|vnext-(?:spv-pass|stage-plan)(?:-[A-Za-z0-9_-]+)?)\.json$/;
  const lineageManifestDigests = new Set<string>();
  for (const record of effectiveReplanDispositions) {
    lineageManifestDigests.add(record.dispositionFact.previous_snapshot.manifest_digest);
    lineageManifestDigests.add(record.dispositionFact.snapshot.manifest_digest);
  }
  for (const raw of output.split('\0').filter((entry) => entry.length > 0)) {
    const relative = rootRelativeFactPath(gitRoot, raw, 'ignored protected path');
    if (relative === currentManifest || allowedContextRefs.has(relative)) continue;
    if (relative === '.proofloop/runtime.lock') { assertIgnoredRuntimeLock(gitRoot, relative); continue; }
    if (relative.startsWith('.proofloop/runtime/')) { assertIgnoredRuntimeArtifact(gitRoot, relative); continue; }
    if (relative.startsWith('.proofloop/context/')) {
      if (!contextPattern.test(relative)) ignoredProtectedMismatch(`ignored protected path is not a digest-addressed Context: ${relative}`);
      const context = readRootBoundJson(gitRoot, relative, 'ignored Context');
      if (!isRecord(context)) ignoredProtectedMismatch(`ignored Context is not a JSON object: ${relative}`);
      const digest = path.posix.basename(relative, '.json');
      const withoutDigest = { ...context }; delete withoutDigest.context_digest;
      if (context.schema_version !== 2 || context.context_digest !== digest || computeDigest(withoutDigest) !== digest) ignoredProtectedMismatch(`ignored protected path is not a valid Runtime Context: ${relative}`);
      if (bindings.some((binding) => context.stage_id === binding.stageId && context.slice_id === binding.sliceId && context.task_id === binding.taskId && context.manifest_digest === binding.manifestDigest && context.plan_digest === binding.planDigest && context.snapshot_digest === binding.snapshotDigest && context.mode === binding.mode)) ignoredProtectedMismatch(`ignored protected path contains an unexpected duplicate current Context: ${relative}`);
      continue;
    }
    if (relative.startsWith(`.proofloop/receipts/plan/${stageId}/`)) {
      const authority = readRootBoundJson(gitRoot, relative, 'ignored vNext plan authority');
      if (isRecord(authority) && authority.stage_id === stageId && ((authority.version === 2 && authority.schema_version === 2 && (authority.type === 'STAGE_PLAN' || authority.type === 'SPV_PASS')) || (relative.endsWith('/epoch.json') && authority.schema_version === 1 && typeof authority.epoch_digest === 'string'))) continue;
    }
    if (relative.startsWith('.proofloop/receipts/') && receiptPattern.test(relative)) continue;
    if (relative.startsWith('.proofloop/manifests/')) {
      const manifest = readRootBoundJson(gitRoot, relative, 'ignored Manifest');
      if (!isRecord(manifest)) ignoredProtectedMismatch(`ignored Manifest is not a JSON object: ${relative}`);
      const isCurrentStageHiddenManifest = relative.startsWith(currentStageHiddenManifestPrefix) || manifest.stage_id === stageId;
      if (!isCurrentStageHiddenManifest) continue;
      try {
        const validated = validateVNextManifest(manifest);
        if (validated.stage_id !== stageId) ignoredProtectedMismatch(`ignored protected path Manifest stage_id does not match the Worker Stage: ${relative}`);
      } catch { ignoredProtectedMismatch(`ignored protected path is not a valid vNext Manifest: ${relative}`); }
      if (lineageManifestDigests.has(computeDigest(manifest))) continue;
      ignoredProtectedMismatch(`ignored protected path is not an admitted Manifest: ${relative}`);
    }
    if (relative.startsWith('.proofloop/receipts/')) ignoredProtectedMismatch(`ignored protected path cannot be hidden from changed_files: ${relative}`);
    ignoredProtectedMismatch(`ignored protected path cannot be hidden from changed_files: ${relative}`);
  }
}
