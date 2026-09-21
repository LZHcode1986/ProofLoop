/**
 * Integration / worktree-cleanup lifecycle facts (S03-E-T02).
 *
 * This is a pure construct/validate seam.  Brain owns MES persistence and
 * routing; this module constructs the existing `git` / `finding` envelopes and
 * validates their bindings.  It does not create a second store or state
 * machine, and it never rolls back an integration commit.
 */

import { SchemaValidationError } from '@proofloop/kernel';
import { canonicalStringify } from '../cli/proofloop-common';
import { canonicalCandidateRef } from '../git-boundary';
import { IntegrationError } from '../git-integration';
import {
  MES_CREATED_BY,
  MES_GIT_SUBKINDS,
  MES_SCHEMA_VERSION,
  MES_SLICE_ID_RE,
} from '../mes/types';
import type {
  MesFactEnvelope,
  MesGitBasis,
  MesPlanBinding,
} from '../mes/types';
import { isCanonicalRootRelativeRef } from '../mes/binding';
import { validateMesFactEnvelope } from '../mes/validate';

/** Slice lifecycle states consumed by the integration/cleanup seam. */
export const INTEGRATION_STATES = [
  'EXECUTING',
  'SLICE_CANDIDATE_READY',
  'CV_PASSED',
  'READY_TO_INTEGRATE',
  'INTEGRATED',
  'CLEANUP_PENDING',
  'CLEANED',
] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

const INTEGRATION_ERROR_CODES = [
  'INTEGRATION.REQUEST_INVALID',
  'INTEGRATION.GIT_UNAVAILABLE',
  'INTEGRATION.HEAD_MISMATCH',
  'INTEGRATION.BRANCH_MISMATCH',
  'INTEGRATION.INDEX_NOT_EMPTY',
  'INTEGRATION.DIRTY_WORKTREE',
  'INTEGRATION.CANDIDATE_REF_INVALID',
  'INTEGRATION.CANDIDATE_BASE_INVALID',
  'INTEGRATION.BASE_NOT_ANCESTOR',
  'INTEGRATION.SCOPE_VIOLATION',
  'INTEGRATION.DIFF_INVALID',
  'INTEGRATION.CONFLICT',
  'INTEGRATION.COMMIT_FAILED',
  'INTEGRATION.POST_COMMIT_INVALID',
 ] as const;
const WORKTREE_ERROR_CODES = new Set([
  'WORKTREE.REQUEST_INVALID',
  'WORKTREE.GIT_UNAVAILABLE',
  'WORKTREE.BASE_REF_INVALID',
  'WORKTREE.PATH_INVALID',
  'WORKTREE.PATH_OCCUPIED',
  'WORKTREE.CREATE_FAILED',
  'WORKTREE.REMOVE_FAILED',
  'WORKTREE.LIST_FAILED',
  'WORKTREE.POST_CREATE_INVALID',
  'WORKTREE.INDEX_NOT_EMPTY',
  'WORKTREE.DIRTY_WORKTREE',
 ]);
/** Closed transition outcomes match the existing MES/lifecycle contract. */
export type IntegrationStateCode = 'RESULT_INVALID' | 'RESULT_BINDING_MISMATCH';
export type IntegrationStateErrorCode = IntegrationStateCode;

export interface IntegrationStateFieldError {
  readonly path: string;
  readonly message: string;
}

/** Fail-closed error for malformed integration/cleanup facts or transitions. */
export class IntegrationStateError extends Error {
  public readonly code: IntegrationStateCode;
  /** Alias used by Result-style consumers. */
  public readonly outcome: IntegrationStateCode;
  public readonly fieldErrors: readonly IntegrationStateFieldError[];

  constructor(
    code: IntegrationStateCode,
    message: string,
    fieldErrors: readonly IntegrationStateFieldError[] = [],
  ) {
    super(message);
    this.name = 'IntegrationStateError';
    this.code = code;
    this.outcome = code;
    this.fieldErrors = fieldErrors;
    Object.setPrototypeOf(this, IntegrationStateError.prototype);
  }
}

/** Builder binding (snake_case is canonical; camelCase is accepted below). */
export interface IntegrationStateBinding {
  readonly stage_id?: string;
  readonly slice_id?: string;
  readonly work_id?: string;
  readonly authority_refs?: readonly string[];
  readonly plan_binding?: MesPlanBinding;
  readonly git_basis?: MesGitBasis;
  readonly stageId?: string;
  readonly sliceId?: string;
  readonly workId?: string;
  readonly authorityRefs?: readonly string[];
  readonly planBinding?: MesPlanBinding;
  readonly gitBasis?: MesGitBasis;
}

/** Builder Git payload; output is the existing closed MES git payload. */
export interface IntegrationGitFacts {
  readonly candidate_ref?: string;
  readonly candidate_base_ref?: string;
  readonly commit_sha?: string;
  readonly changed_files?: readonly string[];
  readonly candidateRef?: string;
  readonly candidateBaseRef?: string;
  readonly base_ref?: string;
  readonly baseRef?: string;
  readonly commitSha?: string;
  readonly changedFiles?: readonly string[];
}

export type IntegrationStateFactInput = IntegrationStateBinding & IntegrationGitFacts & {
  readonly fact_id?: string;
  readonly factId?: string;
  readonly integration_fact?: MesFactEnvelope;
  readonly integrationFact?: MesFactEnvelope;
  readonly integration_result?: unknown;
  readonly integrationResult?: unknown;
  readonly apply_result?: unknown;
  readonly applyResult?: unknown;
  readonly candidate_fact?: MesFactEnvelope;
  readonly candidateFact?: MesFactEnvelope;
  readonly integration_error?: unknown;
  readonly integrationError?: unknown;
  readonly cleanup_error?: unknown;
  readonly cleanupError?: unknown;
  readonly error?: unknown;
};

interface NormalizedBinding {
  readonly stageId: string;
  readonly sliceId: string;
  readonly workId: string;
  readonly authorityRefs: readonly string[];
  readonly planBinding: MesPlanBinding;
  readonly gitBasis: MesGitBasis;
}

interface NormalizedPayload {
  readonly candidateRef: string;
  readonly candidateBaseRef: string;
  readonly commitSha: string;
  readonly changedFiles: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * Canonical root-relative worktree: `.` (the main worktree trust root) or a
 * canonical root-relative path.  Mirrors the established worktree grammar
 * (lane.ts rootRelativeWorktree / successor-barrier.ts isCanonicalWorktreePath
 * / binding.ts closedGitBasisShapeError): `.` is the canonical representation
 * of the main worktree; absolute, traversal, empty-segment, backslash, NUL,
 * drive-prefix and control-character forms all fail closed.
 */
function isCanonicalRootRelativeWorktree(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) return false;
  return value === '.' || isCanonicalRootRelativeRef(value);
}

function stateFail(
  code: IntegrationStateCode,
  message: string,
  fieldErrors: readonly IntegrationStateFieldError[] = [],
): never {
  throw new IntegrationStateError(code, message, fieldErrors);
}

function readField(input: Record<string, unknown>, snake: string, camel: string): unknown {
  return Object.prototype.hasOwnProperty.call(input, snake) ? input[snake] : input[camel];
}
function ensureBuilderFields(input: Record<string, unknown>): void {
  const allowed = new Set([
    'fact_id', 'factId', 'stage_id', 'stageId', 'slice_id', 'sliceId', 'work_id', 'workId',
    'authority_refs', 'authorityRefs', 'plan_binding', 'planBinding', 'git_basis', 'gitBasis',
    'candidate_ref', 'candidateRef', 'candidate_base_ref', 'candidateBaseRef', 'base_ref', 'baseRef',
    'commit_sha', 'commitSha', 'changed_files', 'changedFiles', 'integration_result', 'integrationResult',
    'apply_result', 'applyResult',
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    stateFail('RESULT_INVALID', `integration Git fact input contains unknown field(s): ${unknown.join(', ')}`);
  }
}

function nonEmptyString(value: unknown, label: string, code: IntegrationStateCode = 'RESULT_INVALID'): string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) {
    stateFail(code, `${label} must be a non-empty string without control characters`, [
      { path: label, message: 'Expected a non-empty string without control characters' },
    ]);
  }
  return value;
}

function canonicalStage(value: unknown, label: string): string {
  const stage = nonEmptyString(value, label);
  if (!/^S\d+$/.test(stage)) stateFail('RESULT_INVALID', `${label} must be a canonical Stage ID matching /^S\\d+$/`);
  return stage;
}

function canonicalSlice(value: unknown, stage: string, label: string): string {
  const slice = nonEmptyString(value, label);
  if (!MES_SLICE_ID_RE.test(slice)) stateFail('RESULT_INVALID', `${label} must be a canonical Slice ID matching /^S\\d+-[A-Z]+$/`);
  if (slice.slice(0, slice.lastIndexOf('-')) !== stage) {
    stateFail('RESULT_BINDING_MISMATCH', `${label} must belong to stage ${stage}`);
  }
  return slice;
}

function canonicalFactId(value: unknown, fallback: string): string {
  return value === undefined ? fallback : nonEmptyString(value, 'integration fact.fact_id');
}

function normalizeBinding(value: unknown, source?: MesFactEnvelope): NormalizedBinding {
  const input = isObject(value) ? value : {};
  const scope = source?.scope;
  const stageRaw = readField(input, 'stage_id', 'stageId') ?? scope?.stage_id;
  const stageId = canonicalStage(stageRaw, 'integration.stage_id');
  const sliceRaw = readField(input, 'slice_id', 'sliceId') ?? scope?.slice_id;
  const sliceId = canonicalSlice(sliceRaw, stageId, 'integration.slice_id');
  const workId = nonEmptyString(readField(input, 'work_id', 'workId') ?? source?.work_id, 'integration.work_id', 'RESULT_BINDING_MISMATCH');
  const authorityRefs = (readField(input, 'authority_refs', 'authorityRefs') ?? source?.authority_refs) as unknown;
  if (!Array.isArray(authorityRefs) || authorityRefs.length === 0) {
    stateFail('RESULT_INVALID', 'integration.authority_refs must be a non-empty array');
  }
  const planBinding = readField(input, 'plan_binding', 'planBinding') ?? source?.plan_binding;
  if (!isObject(planBinding) || planBinding.binding_stage !== 'accepted') {
    stateFail('RESULT_BINDING_MISMATCH', 'integration fact requires an accepted plan_binding');
  }
  const gitBasis = readField(input, 'git_basis', 'gitBasis') ?? source?.git_basis;
  if (!isObject(gitBasis)) stateFail('RESULT_BINDING_MISMATCH', 'integration fact requires a git_basis');
  return {
    stageId,
    sliceId,
    workId,
    authorityRefs: authorityRefs as readonly string[],
    planBinding: planBinding as MesPlanBinding,
    gitBasis: gitBasis as unknown as MesGitBasis,
  };
}

function payloadField(input: Record<string, unknown>, snake: string, camel: string): unknown {
  return readField(input, snake, camel);
}

function integrationResultPayload(value: unknown): Partial<NormalizedPayload> & { readonly dirtyAfter?: unknown } {
  if (!isObject(value)) stateFail('RESULT_INVALID', 'integration_result must be an object');
  const candidateRef = payloadField(value, 'candidate_ref', 'candidateRef');
  const candidateBaseRef = payloadField(value, 'candidate_base_ref', 'candidateBaseRef') ?? payloadField(value, 'base_ref', 'baseRef');
  const commitSha = payloadField(value, 'commit_sha', 'commitSha');
  const changedFiles = payloadField(value, 'changed_files', 'changedFiles');
  const dirtyAfter = payloadField(value, 'dirty_after', 'dirtyAfter');
  if (dirtyAfter !== undefined && (!Array.isArray(dirtyAfter) || dirtyAfter.length !== 0)) {
    stateFail('RESULT_BINDING_MISMATCH', 'integration_result must be clean after apply (dirty_after must be [])');
  }
  return {
    ...(candidateRef !== undefined ? { candidateRef: candidateRef as string } : {}),
    ...(candidateBaseRef !== undefined ? { candidateBaseRef: candidateBaseRef as string } : {}),
    ...(commitSha !== undefined ? { commitSha: commitSha as string } : {}),
    ...(changedFiles !== undefined ? { changedFiles: changedFiles as readonly string[] } : {}),
    dirtyAfter,
  };
}

function normalizePayload(value: unknown, resultPayload?: Partial<NormalizedPayload> & { readonly dirtyAfter?: unknown }): NormalizedPayload {
  if (!isObject(value)) stateFail('RESULT_INVALID', 'integration Git fact input must be an object');
  const direct: Partial<NormalizedPayload> = {
    candidateRef: payloadField(value, 'candidate_ref', 'candidateRef') as string | undefined,
    candidateBaseRef: (payloadField(value, 'candidate_base_ref', 'candidateBaseRef') ?? payloadField(value, 'base_ref', 'baseRef')) as string | undefined,
    commitSha: payloadField(value, 'commit_sha', 'commitSha') as string | undefined,
    changedFiles: payloadField(value, 'changed_files', 'changedFiles') as readonly string[] | undefined,
  };
  const pick = <K extends keyof NormalizedPayload>(key: K, label: string): NormalizedPayload[K] => {
    const fromResult = resultPayload?.[key];
    const fromDirect = direct[key];
    if (fromResult !== undefined && fromDirect !== undefined && canonicalStringify(fromResult) !== canonicalStringify(fromDirect)) {
      stateFail('RESULT_BINDING_MISMATCH', `${label} differs from the integration apply Git result`);
    }
    const chosen = fromDirect ?? fromResult;
    if (chosen === undefined) stateFail('RESULT_INVALID', `${label} is required in the integration Git payload`);
    return chosen as NormalizedPayload[K];
  };
  return {
    candidateRef: nonEmptyString(pick('candidateRef', 'candidate_ref'), 'integration.candidate_ref', 'RESULT_BINDING_MISMATCH'),
    candidateBaseRef: nonEmptyString(pick('candidateBaseRef', 'candidate_base_ref'), 'integration.candidate_base_ref', 'RESULT_BINDING_MISMATCH'),
    commitSha: nonEmptyString(pick('commitSha', 'commit_sha'), 'integration.commit_sha', 'RESULT_BINDING_MISMATCH'),
    changedFiles: pick('changedFiles', 'changed_files'),
  };
}

function validatePayload(
  fact: MesFactEnvelope,
  binding: NormalizedBinding,
  expectedSubkind: (typeof MES_GIT_SUBKINDS)[number],
  expectedPayload?: NormalizedPayload,
): MesFactEnvelope {
  let validated: MesFactEnvelope;
  try {
    validated = validateMesFactEnvelope(fact);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const fieldErrors = error instanceof SchemaValidationError ? error.fieldErrors : [];
    stateFail('RESULT_INVALID', `${expectedSubkind} Git fact envelope validation failed: ${detail}`, fieldErrors);
  }
  if (validated.fact_kind !== 'git' || validated.git_subkind !== expectedSubkind) {
    stateFail('RESULT_INVALID', `expected a git fact with git_subkind ${expectedSubkind}`);
  }
  const scope = validated.scope;
  if (
    !isObject(scope) ||
    scope.stage_id !== binding.stageId ||
    scope.slice_id !== binding.sliceId ||
    scope.task_id !== undefined
  ) {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact scope does not match the lane binding`);
  }
  if (validated.work_id !== binding.workId) stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact work_id does not match the lane binding`);
  if (validated.plan_binding === undefined || validated.plan_binding.binding_stage !== 'accepted') {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact must carry an accepted plan_binding`);
  }
  if (canonicalStringify(validated.plan_binding) !== canonicalStringify(binding.planBinding)) {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact plan_binding does not match the lane binding`);
  }
  if (validated.git_basis === undefined || canonicalStringify(validated.git_basis) !== canonicalStringify(binding.gitBasis)) {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact git_basis does not match the lane binding`);
  }
  if (!Array.isArray(validated.authority_refs) || canonicalStringify(validated.authority_refs) !== canonicalStringify(binding.authorityRefs)) {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact authority_refs do not match the lane binding`);
  }
  if (!isCanonicalRootRelativeWorktree(validated.git_basis.worktree)) {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact git_basis.worktree must be '.' (main worktree) or a canonical root-relative path`);
  }
  const candidateRef = validated.candidate_ref;
  const expectedCandidateRef = canonicalCandidateRef(binding.stageId, binding.sliceId);
  if (candidateRef !== expectedCandidateRef) {
    stateFail(
      'RESULT_BINDING_MISMATCH',
      `${expectedSubkind} fact candidate_ref must be canonical ${expectedCandidateRef}, got ${JSON.stringify(candidateRef)}`,
    );
  }
  const candidateBaseRef = validated.candidate_base_ref;
  if (typeof candidateBaseRef !== 'string' || !isCanonicalRootRelativeRef(candidateBaseRef)) {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact candidate_base_ref must be a canonical Git ref`);
  }
  const commitSha = validated.commit_sha;
  if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(commitSha)) {
    stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact commit_sha must be a 40-char lowercase Git SHA`);
  }
  const changedFiles = validated.changed_files;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    stateFail('RESULT_INVALID', `${expectedSubkind} fact changed_files must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const file of changedFiles) {
    if (typeof file !== 'string' || !isCanonicalRootRelativeRef(file)) {
      stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact changed_files must contain canonical root-relative paths`);
    }
    if (file === '.git' || file.startsWith('.git/') || file === '.proofloop' || file.startsWith('.proofloop/')) {
      stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact changed_files cannot contain protected paths`);
    }
    if (seen.has(file)) stateFail('RESULT_INVALID', `${expectedSubkind} fact changed_files contains duplicate path ${file}`);
    seen.add(file);
  }
  if (expectedPayload !== undefined) {
    if (
      candidateRef !== expectedPayload.candidateRef ||
      candidateBaseRef !== expectedPayload.candidateBaseRef ||
      commitSha !== expectedPayload.commitSha ||
      canonicalStringify(changedFiles) !== canonicalStringify(expectedPayload.changedFiles)
    ) {
      stateFail('RESULT_BINDING_MISMATCH', `${expectedSubkind} fact does not equal the integration apply Git result`);
    }
  }
  return validated;
}

function buildGitFact(value: unknown, subkind: (typeof MES_GIT_SUBKINDS)[number]): MesFactEnvelope {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) stateFail('RESULT_INVALID', `${subkind} Git fact input must be an object`);
  if (Object.prototype.hasOwnProperty.call(input, 'fact_kind')) {
    return validateGitFact(input, subkind);
  }
  ensureBuilderFields(input);
  const resultRaw = input.integration_result ?? input.integrationResult ?? input.apply_result ?? input.applyResult;
  const resultPayload = resultRaw === undefined ? undefined : integrationResultPayload(resultRaw);
  const binding = normalizeBinding(input);
  const payload = normalizePayload(input, resultPayload);
  const factId = canonicalFactId(
    input.fact_id ?? input.factId,
    `mes:fact:git:${binding.stageId}:${binding.sliceId}:${subkind}`,
  );
  const envelope: MesFactEnvelope = {
    schema_version: MES_SCHEMA_VERSION,
    fact_id: factId,
    fact_kind: 'git',
    created_by: MES_CREATED_BY[0],
    authority_refs: [...binding.authorityRefs],
    scope: { stage_id: binding.stageId, slice_id: binding.sliceId },
    work_id: binding.workId,
    plan_binding: binding.planBinding,
    git_basis: binding.gitBasis,
    git_subkind: subkind,
    candidate_ref: payload.candidateRef,
    candidate_base_ref: payload.candidateBaseRef,
    commit_sha: payload.commitSha,
    changed_files: [...payload.changedFiles],
  };
  return validateGitFact(envelope, subkind, payload);
}

function validateGitFact(
  value: unknown,
  subkind: (typeof MES_GIT_SUBKINDS)[number],
  expectedPayload?: NormalizedPayload,
): MesFactEnvelope {
  if (!isObject(value)) stateFail('RESULT_INVALID', `${subkind} Git fact must be an object`);
  const fact = (() => {
    try {
      return validateMesFactEnvelope(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const fieldErrors = error instanceof SchemaValidationError ? error.fieldErrors : [];
      stateFail('RESULT_INVALID', `${subkind} Git fact envelope validation failed: ${detail}`, fieldErrors);
    }
  })();
  const binding = normalizeBinding({}, fact);
  return validatePayload(fact, binding, subkind, expectedPayload);
}

/** Construct a candidate Git fact from the closed boundary candidate payload. */
export function buildCandidateFact(value: unknown): MesFactEnvelope {
  return buildGitFact(value, 'candidate');
}

/** Validate a durable candidate Git fact. */
export function validateCandidateFact(value: unknown): MesFactEnvelope {
  return validateGitFact(value, 'candidate');
}

/**
 * Construct the durable `INTEGRATED` Git fact from `integration apply` facts.
 * An optional `integration_result` is checked field-for-field; no caller value
 * can silently replace the apply result.
 */
export function buildIntegrationFact(value: unknown, integrationResult?: unknown): MesFactEnvelope {
  if (integrationResult !== undefined && isObject(value) && isObject(integrationResult)) {
    const second = integrationResult as Record<string, unknown>;
    const secondLooksLikeBinding =
      second.stage_id !== undefined || second.stageId !== undefined ||
      second.plan_binding !== undefined || second.planBinding !== undefined ||
      second.git_basis !== undefined || second.gitBasis !== undefined;
    if (secondLooksLikeBinding) {
      return buildGitFact({ ...second, integration_result: value }, 'integration');
    }
    return buildGitFact({ ...value, integration_result: integrationResult }, 'integration');
  }
  return buildGitFact(value, 'integration');
}

/** Alias matching the milestone wording used by Brain/Execute callers. */
export const buildIntegratedFact = buildIntegrationFact;

/** Validate the durable Git fact that signals `INTEGRATED`. */
export function validateIntegrationFact(value: unknown, expected?: unknown): MesFactEnvelope {
  const expectedPayload = expected === undefined ? undefined : normalizePayload(isObject(expected) ? expected : {}, undefined);
  return validateGitFact(value, 'integration', expectedPayload);
}

function assertOptionalCleanupInputsMatch(input: Record<string, unknown>, integration: MesFactEnvelope): void {
  const checks: Array<[string, string, keyof MesFactEnvelope]> = [
    ['stage_id', 'stageId', 'scope'],
    ['slice_id', 'sliceId', 'scope'],
    ['work_id', 'workId', 'work_id'],
    ['authority_refs', 'authorityRefs', 'authority_refs'],
    ['plan_binding', 'planBinding', 'plan_binding'],
    ['git_basis', 'gitBasis', 'git_basis'],
    ['candidate_ref', 'candidateRef', 'candidate_ref'],
    ['candidate_base_ref', 'candidateBaseRef', 'candidate_base_ref'],
    ['commit_sha', 'commitSha', 'commit_sha'],
    ['changed_files', 'changedFiles', 'changed_files'],
  ];
  for (const [snake, camel, field] of checks) {
    const supplied = input[snake] ?? input[camel];
    if (supplied === undefined) continue;
    const expected = field === 'scope'
      ? (snake === 'stage_id' ? integration.scope?.stage_id : integration.scope?.slice_id)
      : integration[field];
    if (canonicalStringify(supplied) !== canonicalStringify(expected)) {
      stateFail('RESULT_BINDING_MISMATCH', `cleanup input field ${snake} does not match the preceding integration fact`);
    }
  }
}

/** Construct the durable `CLEANED` Git fact from an already integrated fact. */
export function buildCleanupFact(value: unknown): MesFactEnvelope {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) stateFail('RESULT_INVALID', 'cleanup Git fact input must be an object');
  if (input.fact_kind === 'git' && input.git_subkind === 'cleanup') return validateCleanupFact(input);
  const sourceRaw = input.integration_fact ?? input.integrationFact ?? (input.fact_kind === 'git' ? input : undefined);
  if (sourceRaw === undefined) stateFail('RESULT_BINDING_MISMATCH', 'cleanup fact requires the preceding integration_fact');
  const integration = validateIntegrationFact(sourceRaw);
  assertOptionalCleanupInputsMatch(input, integration);
  const binding = normalizeBinding({}, integration);
  const payload: NormalizedPayload = {
    candidateRef: integration.candidate_ref as string,
    candidateBaseRef: integration.candidate_base_ref as string,
    commitSha: integration.commit_sha as string,
    changedFiles: integration.changed_files as readonly string[],
  };
  const factId = canonicalFactId(
    input.fact_id ?? input.factId,
    `mes:fact:git:${binding.stageId}:${binding.sliceId}:cleanup`,
  );
  const cleanup: MesFactEnvelope = {
    ...integration,
    fact_id: factId,
    git_subkind: 'cleanup',
  };
  return validateCleanupFact(cleanup, integration);
}

/** Validate `CLEANUP_PENDING → CLEANED` against the exact integration payload. */
export function validateCleanupFact(value: unknown, integrationFact?: unknown): MesFactEnvelope {
  const cleanup = validateGitFact(value, 'cleanup');
  if (integrationFact !== undefined) {
    const integration = validateIntegrationFact(integrationFact);
    const fields: Array<keyof MesFactEnvelope> = [
      'scope',
      'work_id',
      'plan_binding',
      'git_basis',
      'candidate_ref',
      'candidate_base_ref',
      'commit_sha',
      'changed_files',
    ];
    for (const field of fields) {
      if (canonicalStringify(cleanup[field]) !== canonicalStringify(integration[field])) {
        stateFail('RESULT_BINDING_MISMATCH', `cleanup fact field ${field} does not match the preceding integration fact`);
      }
    }
  }
  return cleanup;
}

export const buildCleanupLifecycleFact = buildCleanupFact;
export const validateCleanupLifecycleFact = validateCleanupFact;
export const validateIntegratedMilestoneFact = validateIntegrationFact;
export const createCandidateFact = buildCandidateFact;
export const buildCandidateGitFact = buildCandidateFact;
export const createIntegrationFact = buildIntegrationFact;
export const buildIntegrationGitFact = buildIntegrationFact;
export const createCleanupFact = buildCleanupFact;
export const buildCleanupGitFact = buildCleanupFact;
export const validateIntegratedFact = validateIntegrationFact;

const INTEGRATION_TRANSITIONS: Readonly<Record<IntegrationState, readonly IntegrationState[]>> = {
  EXECUTING: ['SLICE_CANDIDATE_READY'],
  SLICE_CANDIDATE_READY: ['CV_PASSED'],
  CV_PASSED: ['READY_TO_INTEGRATE'],
  READY_TO_INTEGRATE: ['INTEGRATED'],
  INTEGRATED: ['CLEANUP_PENDING'],
  CLEANUP_PENDING: ['CLEANED'],
  CLEANED: [],
};

/** Return whether one closed integration lifecycle transition is legal. */
export function isLegalIntegrationTransition(current: unknown, next: unknown): boolean {
  if (
    typeof current !== 'string' ||
    typeof next !== 'string' ||
    !(INTEGRATION_STATES as readonly string[]).includes(current) ||
    !(INTEGRATION_STATES as readonly string[]).includes(next)
  ) return false;
  return (INTEGRATION_TRANSITIONS[current as IntegrationState] as readonly string[]).includes(next);
}

export interface IntegrationTransitionInput {
  readonly current?: unknown;
  readonly next?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly currentState?: unknown;
  readonly nextState?: unknown;
}

/** Assert a legal integration lifecycle transition; cleanup failure is not a rollback transition. */
export function validateIntegrationTransition(current: unknown, next?: unknown): true {
  if (next === undefined && isObject(current)) {
    next = current.next ?? current.to ?? current.nextState;
    current = current.current ?? current.from ?? current.currentState;
  }
  if (!isLegalIntegrationTransition(current, next)) {
    stateFail('RESULT_INVALID', `illegal integration lifecycle transition ${JSON.stringify(current)} → ${JSON.stringify(next)}`);
  }
  return true;
}

export const assertIntegrationTransition = validateIntegrationTransition;
export const isValidIntegrationTransition = isLegalIntegrationTransition;

/**
 * Deterministically project the integration portion of a fact set.  A cleanup
 * failure does not remove the integration fact, so the business state remains
 * `INTEGRATED`; only a durable cleanup fact advances it to `CLEANED`.
 */
export function projectIntegrationState(facts: readonly MesFactEnvelope[]): IntegrationState {
  if (!Array.isArray(facts)) stateFail('RESULT_INVALID', 'integration state input must be an array of MES facts');
  let integration: MesFactEnvelope | undefined;
  let cleanup: MesFactEnvelope | undefined;
  let hasCandidate = false;
  for (const raw of facts) {
    if (!isObject(raw)) stateFail('RESULT_INVALID', 'integration state facts must be envelope objects');
    if (raw.fact_kind !== 'git') continue;
    const subkind = raw.git_subkind;
    if (subkind === 'cleanup') {
      const validated = validateCleanupFact(raw);
      if (cleanup !== undefined && canonicalStringify(cleanup) !== canonicalStringify(validated)) {
        stateFail('RESULT_INVALID', 'integration state contains conflicting cleanup facts');
      }
      cleanup = validated;
    } else if (subkind === 'integration') {
      const validated = validateIntegrationFact(raw);
      if (integration !== undefined && canonicalStringify(integration) !== canonicalStringify(validated)) {
        stateFail('RESULT_INVALID', 'integration state contains conflicting integration facts');
      }
      integration = validated;
    } else if (subkind === 'candidate') {
      validateCandidateFact(raw);
      hasCandidate = true;
    }
  }
  if (cleanup !== undefined) {
    if (integration === undefined) {
      stateFail('RESULT_BINDING_MISMATCH', 'cleanup fact requires a preceding integration fact');
    }
    validateCleanupFact(cleanup, integration);
    return 'CLEANED';
  }
  if (integration !== undefined) return 'INTEGRATED';
  if (hasCandidate) return 'READY_TO_INTEGRATE';
  return 'EXECUTING';
}

export const deriveIntegrationState = projectIntegrationState;
export const projectSliceIntegrationState = projectIntegrationState;

interface FailureLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

function integrationFailureDetails(value: unknown): { code: string; message: string } {
  if (!isObject(value)) stateFail('RESULT_INVALID', 'integration failure must be a typed IntegrationError');
  const code = value.code;
  const message = value.message;
  if (typeof code !== 'string' || !(INTEGRATION_ERROR_CODES as readonly string[]).includes(code) || typeof message !== 'string' || message.length === 0 || hasControlCharacter(message)) {
    stateFail('RESULT_INVALID', 'integration failure must carry a typed INTEGRATION.* code and non-empty message');
  }
  return { code, message };
}

function failureFinding(
  bindingFact: MesFactEnvelope,
  failure: { code: string; message: string },
  factId: string,
): MesFactEnvelope {
  const evidence = [
    failure.code,
    String(bindingFact.candidate_ref),
    failure.message,
    `candidate_ref:${String(bindingFact.candidate_ref)}`,
    `candidate_base_ref:${String(bindingFact.candidate_base_ref)}`,
    `commit_sha:${String(bindingFact.commit_sha)}`,
    ...(bindingFact.changed_files ?? []).map((file) => `changed_file:${file}`),
  ];
  try {
    return validateMesFactEnvelope({
      schema_version: MES_SCHEMA_VERSION,
      fact_id: factId,
      fact_kind: 'finding',
      created_by: MES_CREATED_BY[0],
      authority_refs: [...bindingFact.authority_refs],
      scope: bindingFact.scope,
      work_id: bindingFact.work_id,
      plan_binding: bindingFact.plan_binding,
      git_basis: bindingFact.git_basis,
      verifier_verdict: 'BLOCKED',
      finding_evidence_refs: evidence,
      // This is evidence for Brain arbitration, not an automatic route.
      claimed_route_code: 'RUNTIME_BLOCKER',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const fieldErrors = error instanceof SchemaValidationError ? error.fieldErrors : [];
    stateFail('RESULT_BINDING_MISMATCH', `integration failure finding does not bind to the integration fact: ${detail}`, fieldErrors);
  }
}

function validateFailureSource(value: unknown): MesFactEnvelope {
  if (!isObject(value)) stateFail('RESULT_BINDING_MISMATCH', 'integration failure finding source must be a Git fact');
  if (value.fact_kind === 'git' && value.git_subkind === 'candidate') return validateCandidateFact(value);
  return validateIntegrationFact(value);
}

/** Convert a typed `IntegrationError` into a durable finding for Brain. */
export function buildIntegrationFailureFinding(value: unknown): MesFactEnvelope {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) stateFail('RESULT_INVALID', 'integration failure finding input must be an object');
  const sourceRaw = input.integration_fact ?? input.integrationFact ?? input.candidate_fact ?? input.candidateFact;
  if (sourceRaw === undefined) stateFail('RESULT_BINDING_MISMATCH', 'integration failure finding requires integration_fact or candidate_fact');
  const integration = validateFailureSource(sourceRaw);
  const rawError = input.error ?? input.integration_error ?? input.integrationError;
  if (!(rawError instanceof IntegrationError) && !(isObject(rawError) && typeof rawError.code === 'string')) {
    stateFail('RESULT_INVALID', 'integration failure finding requires a typed IntegrationError');
  }
  const failure = integrationFailureDetails(rawError as FailureLike);
  const suppliedFactId = input.fact_id ?? input.factId;
  const factId = canonicalFactId(
    suppliedFactId,
    `mes:fact:finding:${integration.scope?.stage_id}:${integration.scope?.slice_id}:integration-${failure.code.slice('INTEGRATION.'.length).toLowerCase()}`,
  );
  return failureFinding(integration, failure, factId);
}

export const buildIntegrationFailureFindingFact = buildIntegrationFailureFinding;

/** Durable finding form of a cleanup anomaly; it does not change INTEGRATED state. */
export function buildCleanupFailureFinding(value: unknown): MesFactEnvelope {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) stateFail('RESULT_INVALID', 'cleanup failure finding input must be an object');
  const sourceRaw = input.integration_fact ?? input.integrationFact;
  if (sourceRaw === undefined) stateFail('RESULT_BINDING_MISMATCH', 'cleanup failure finding requires integration_fact');
  const integration = validateIntegrationFact(sourceRaw);
  const rawError = input.error ?? input.cleanup_error ?? input.cleanupError;
  if (!isObject(rawError) || typeof rawError.code !== 'string' || !WORKTREE_ERROR_CODES.has(rawError.code)) {
    stateFail('RESULT_INVALID', 'cleanup failure finding requires a typed WORKTREE.* error');
  }
  const failure = { code: rawError.code, message: typeof rawError.message === 'string' ? rawError.message : rawError.code };
  const suppliedFactId = input.fact_id ?? input.factId;
  const factId = canonicalFactId(
    suppliedFactId,
    `mes:fact:finding:${integration.scope?.stage_id}:${integration.scope?.slice_id}:cleanup-${failure.code.slice('WORKTREE.'.length).toLowerCase()}`,
  );
  return failureFinding(integration, failure, factId);
}

/**
 * In-memory anomaly projection used by Brain before/alongside persisting the
 * existing finding fact.  There is intentionally no new MES fact kind.
 */
export interface CleanupFailureAnomaly {
  readonly anomaly: 'cleanup';
  readonly state: 'INTEGRATED';
  readonly cleanup_pending: true;
  readonly error_code: string;
  readonly reason: string;
  readonly integration_fact: MesFactEnvelope;
}

export function buildCleanupFailureAnomaly(value: unknown): CleanupFailureAnomaly {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) stateFail('RESULT_INVALID', 'cleanup anomaly input must be an object');
  const sourceRaw = input.integration_fact ?? input.integrationFact;
  if (sourceRaw === undefined) stateFail('RESULT_BINDING_MISMATCH', 'cleanup anomaly requires integration_fact');
  const integration = validateIntegrationFact(sourceRaw);
  const error = input.error ?? input.cleanup_error ?? input.cleanupError;
  if (!isObject(error) || typeof error.code !== 'string' || !WORKTREE_ERROR_CODES.has(error.code)) {
    stateFail('RESULT_INVALID', 'cleanup anomaly requires a typed WORKTREE.* error');
  }
  const reason = typeof error.message === 'string' && error.message.length > 0 ? error.message : error.code;
  if (hasControlCharacter(reason)) stateFail('RESULT_INVALID', 'cleanup anomaly reason must not contain control characters');
  return {
    anomaly: 'cleanup',
    state: 'INTEGRATED',
    cleanup_pending: true,
    error_code: error.code,
    reason,
    integration_fact: integration,
  };
}

export const buildCleanupAnomaly = buildCleanupFailureAnomaly;
export const recordCleanupFailure = buildCleanupFailureAnomaly;
