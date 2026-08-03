/**
 * @proofloop/runtime — Project Acceptance (B1c, blueprint §6.4 proofloop_project)
 *
 * The project-level acceptance pipeline ported onto the new runtime
 * infrastructure:
 *
 *   compileProjectAcceptance — COMPILE_ACCEPTANCE: build the
 *     ProjectAcceptanceManifest from a plain input JSON (project_root,
 *     project_id, prd_goals, acceptance_criteria, stage_receipts, e2e_steps),
 *     compute the git-based expected_snapshot of project_root and the
 *     canonical manifest digest, and write the manifest to the output path.
 *
 *   runProjectAcceptanceE2E — RUN_E2E: read + validate the manifest, execute
 *     every e2e_steps entry through the B1a Process Runner (runProcess for
 *     command/probe steps, spawnService/registerService/stopService for the
 *     service lifecycle, waitForReadiness for readiness signals), enforce the
 *     expected oracle (exit_code absent → 0, null → any, else exact match;
 *     output_contains / output_matches / readiness_signal /
 *     expected_observation), stop at the first failed step, run mandatory
 *     service cleanup, derive the verdict (PASS / FAIL; BLOCKED reserved by
 *     the schema), and persist the Project E2E Gate Receipt through the
 *     kernel `writeReceipt` into the canonical `project/` receipt category
 *     (receipt-layout projectReceiptDir) with type PROJECT_E2E_PASS /
 *     PROJECT_E2E_FAIL / PROJECT_E2E_BLOCKED per verdict.
 *
 *   finalizeProjectReview — FINALIZE_PROJECT_REVIEW: cross-validate the
 *     Manifest + Project E2E Gate Receipt + independent Project Review Result
 *     (chain consistency: schema, verdict PASS, project_id / manifest_digest
 *     / expected_snapshot / executed_snapshot binding, non-skipped steps,
 *     per-stage manifest/review/gate triple-binding, criteria one-to-one
 *     coverage) and, when everything passes, persist the final Project Review
 *     Receipt (type PROJECT_REVIEW_PASS) through the kernel `writeReceipt`
 *     with previous_digest chained to the E2E gate receipt.
 *
 * All receipt writes go through the kernel ReceiptWriter (immutable, digest +
 * chain semantics) — no hand-written JSON receipts. All schemas are local
 * pure-TypeScript validators (the new runtime has zero dependencies; the
 * legacy runtime used zod) with structured issue paths mirroring the legacy
 * zod schemas (.agents/runtime/src/schemas.ts — behavior authority).
 *
 * Deliberate differences vs. the legacy runtime (recorded, see also each
 * function JSDoc):
 *   - snapshot: legacy computeSnapshot hashed the directory tree contents
 *     (excluding .git/node_modules/hidden); the new computeSnapshot is
 *     git-based (HEAD sha + `git status --porcelain` summary → sha256 →
 *     16-char hex) — deterministic, cheap, still 16-char truncated;
 *   - E2E receipt: legacy wrote a plain JSON file `project-e2e-<id>.json`
 *     (no digest/chain); the new receipt is a kernel Receipt envelope whose
 *     `payload` carries the legacy ProjectE2EReceipt content, named by the
 *     kernel `<digest>.json` convention in `project/`;
 *   - E2E envelope `stage_id` carries the project_id (kernel Receipt requires
 *     a non-empty stage_id; the legacy E2E receipt had no stage_id);
 *   - expected.exit_code: `null` means "any exit accepted" (new-runtime
 *     run-gate semantics); the legacy executor coerced null to 0 via `?? 0`;
 *   - manifest digest: canonical (sorted-key) JSON sha256 over the VALIDATED
 *     object (pure-TS validators do not transform; legacy zod parse filled
 *     defaults before digesting — compile writes the validated object, so
 *     file content and digest are consistent by construction);
 *   - the legacy ALL_STEPS_SKIPPED / zero-step / topology / stale-snapshot
 *     failure modes are preserved verbatim.
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateReceipt, validateManifest, writeReceipt, SchemaValidationError } from '@proofloop/kernel';
import {
  runProcess,
  spawnService,
  registerService,
  getRegisteredService,
  stopService,
  waitForReadiness,
  cleanupServices,
} from './process-runner';
import type { ServiceCleanupResult } from './process-runner';
import { projectReceiptDir } from './receipt-layout';

// ============================================================
// Types & local schemas (pure TypeScript, zero deps)
// ============================================================

/** Structured validation issue (legacy zod issue-path style). */
export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

/** Error thrown by the local schema validators (RUNTIME.SCHEMA_MISMATCH analog). */
export class ProjectAcceptanceSchemaError extends Error {
  public readonly issues: readonly SchemaIssue[];
  constructor(issues: readonly SchemaIssue[]) {
    super(`Project Acceptance schema validation failed (${issues.length} issue(s))`);
    this.name = 'ProjectAcceptanceSchemaError';
    this.issues = issues;
  }
}

/** Runtime proof step (legacy RuntimeProofStep shape, behavior authority). */
export interface RuntimeProofStep {
  id: string;
  type?: 'command' | 'probe' | 'service_start' | 'service_stop';
  executable: string;
  args: string[];
  cwd?: string;
  timeout_ms?: number;
  readiness_signal?: string;
  service_ref?: string;
  expected_observation?: string;
  not_applicable?: { reason: string };
  expected?: {
    exit_code?: number | null;
    output_contains?: string;
    output_matches?: string;
  };
}

/** One stage evidence entry inside the Project Acceptance Manifest. */
export interface StageReceiptEntry {
  stage_id: string;
  stage_manifest: { path: string; digest: string };
  review_receipt: { path: string; digest: string };
  gate_receipt: { path: string; digest: string };
}

/** Project Acceptance Manifest (legacy ProjectAcceptanceManifestSchema). */
export interface ProjectAcceptanceManifest {
  project_id: string;
  expected_snapshot: string;
  prd_goals: string[];
  acceptance_criteria: string[];
  stage_receipts: StageReceiptEntry[];
  e2e_steps: RuntimeProofStep[];
  compiled_at?: string;
}

/** One E2E step result inside the E2E receipt (legacy shape). */
export interface E2EStepResult {
  step_id: string;
  exit_code: number | null;
  observations?: string;
  skipped?: boolean;
}

/** Service cleanup result (legacy shape). */
export interface ServiceCleanupResultShape {
  cleaned: string[];
  failed: Array<{ service: string; pid: number; reason: string }>;
  remainingPids: number[];
}

/** Project E2E Gate Receipt payload (legacy ProjectE2EReceiptSchema). */
export interface ProjectE2EReceipt {
  project_id: string;
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  snapshot: string;
  manifest_digest: string;
  expected_snapshot: string;
  executed_snapshot: string;
  steps: E2EStepResult[];
  service_cleanup: ServiceCleanupResultShape;
  created_at: string;
}

/** Stage Review Receipt (legacy StageReviewReceiptSchema). */
export interface StageReviewReceipt {
  stage_id: string;
  verdict: 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
  snapshot: string;
  manifest_digest: string;
  stage_gate_receipt: { path: string; digest: string };
  findings?: Array<{ category: string; description: string }>;
  reviewer: string;
  reviewed_at: string;
}

/** Stage Gate Receipt (legacy StageGateReceipt). */
export interface StageGateReceipt {
  stage_id: string;
  snapshot: string;
  manifest_digest: string;
  completed_slice_ids?: string[];
  slice_complete_facts?: Array<Record<string, unknown>>;
  manifest_path?: string;
  platform: string;
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  steps: Array<{ id: string; exit_code: number | null; skipped?: boolean; observations?: string }>;
  service_cleanup: ServiceCleanupResultShape;
  timestamps: { started_at: string; completed_at: string };
}

/** Independent Project Reviewer result (legacy ProjectReviewResultSchema). */
export interface ProjectReviewResult {
  verdict: 'PROJECT_ACCEPTED' | 'PROJECT_REJECTED' | 'PROJECT_BLOCKED';
  reviewer: string;
  reviewed_snapshot: string;
  project_manifest: { path: string; digest: string };
  project_e2e_receipt: { path: string; digest: string };
  criteria_results: Array<{ criteria: string; passed: boolean; notes?: string }>;
  findings?: Array<{ category: string; description: string }>;
  accepted_deviations?: string[];
  reviewed_at: string;
}

/** Final Project Review Receipt payload (legacy WriteProjectReviewReceiptOptions). */
export interface ProjectReviewReceipt {
  project_id: string;
  verdict: 'PROJECT_ACCEPTED' | 'PROJECT_REJECTED' | 'PROJECT_BLOCKED';
  snapshot: string;
  reviewer: string;
  findings: Array<{ category: string; description: string }>;
  accepted_deviations: string[];
  project_manifest: { path: string; digest: string };
  project_e2e_receipt: { path: string; digest: string };
  reviewed_at: string;
  stage_receipts: Array<{
    stage_id: string;
    stage_manifest: { path: string; digest: string };
    review: { path: string; digest: string };
    gate: { path: string; digest: string };
    snapshot: string;
  }>;
  criteria_results: Array<{ criteria: string; passed: boolean; notes?: string }>;
}

/** Kernel receipt type for each E2E verdict (B1c additive types). */
export const PROJECT_E2E_TYPE_BY_VERDICT: Readonly<
  Record<ProjectE2EReceipt['verdict'], 'PROJECT_E2E_PASS' | 'PROJECT_E2E_FAIL' | 'PROJECT_E2E_BLOCKED'>
> = {
  PASS: 'PROJECT_E2E_PASS',
  FAIL: 'PROJECT_E2E_FAIL',
  BLOCKED: 'PROJECT_E2E_BLOCKED',
} as const;

/** Closed set of the three B1c additive project E2E receipt types. */
export const PROJECT_E2E_TYPES: readonly string[] = [
  'PROJECT_E2E_PASS',
  'PROJECT_E2E_FAIL',
  'PROJECT_E2E_BLOCKED',
] as const;

// ============================================================
// Validation helpers (pure TypeScript, mirror legacy zod schemas)
// ============================================================

const HEX16 = /^[a-f0-9]{16}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(issues: SchemaIssue[], pathStr: string, message: string): void {
  issues.push({ path: pathStr, message });
}

function expectObject(
  value: unknown,
  pathStr: string,
  issues: SchemaIssue[],
): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    issue(issues, pathStr, `Expected object, got ${value === null ? 'null' : typeof value}`);
    return undefined;
  }
  return value;
}

function expectString(
  value: unknown,
  pathStr: string,
  issues: SchemaIssue[],
  opts?: { min?: number; regex?: RegExp },
): string | undefined {
  if (typeof value !== 'string') {
    issue(issues, pathStr, `Expected string, got ${value === null ? 'null' : typeof value}`);
    return undefined;
  }
  if (opts?.min !== undefined && value.length < opts.min) {
    issue(issues, pathStr, `String must be at least ${opts.min} character(s)`);
    return undefined;
  }
  if (opts?.regex !== undefined && !opts.regex.test(value)) {
    issue(issues, pathStr, `String does not match ${opts.regex}`);
    return undefined;
  }
  return value;
}

function expectOptionalString(value: unknown, pathStr: string, issues: SchemaIssue[]): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, pathStr, issues);
}

function expectOptionalNumber(value: unknown, pathStr: string, issues: SchemaIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    issue(issues, pathStr, `Expected number, got ${value === null ? 'null' : typeof value}`);
    return undefined;
  }
  return value;
}

function expectNonEmptyArray<T>(value: unknown, pathStr: string, issues: SchemaIssue[]): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, pathStr, 'Expected array');
    return undefined;
  }
  if (value.length === 0) {
    issue(issues, pathStr, 'Array must contain at least one entry');
    return undefined;
  }
  return value;
}

function expectStringArray(value: unknown, pathStr: string, issues: SchemaIssue[], min = 1): string[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, pathStr, 'Expected array');
    return undefined;
  }
  if (value.length < min) {
    issue(issues, pathStr, `Array must contain at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
    return undefined;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || value[i].length < 1) {
      issue(issues, pathStr, `Entry ${i} must be a non-empty string`);
      return undefined;
    }
  }
  return value as string[];
}

/** path+digest reference: both required; digest is 16-char hex (legacy). */
function parsePathDigestRef(
  value: unknown,
  pathStr: string,
  issues: SchemaIssue[],
): { path: string; digest: string } | undefined {
  const obj = expectObject(value, pathStr, issues);
  if (!obj) return undefined;
  let valid = true;
  const p = expectString(obj['path'], `${pathStr}.path`, issues, { min: 1 });
  const d = expectString(obj['digest'], `${pathStr}.digest`, issues, { regex: HEX16 });
  if (p === undefined || d === undefined) valid = false;
  return valid ? { path: p as string, digest: d as string } : undefined;
}

/** RuntimeProofStep validator (legacy RuntimeProofStep zod, behavior authority). */
function parseRuntimeProofStep(value: unknown, pathStr: string, issues: SchemaIssue[]): RuntimeProofStep | undefined {
  const obj = expectObject(value, pathStr, issues);
  if (!obj) return undefined;
  let valid = true;
  const id = expectString(obj['id'], `${pathStr}.id`, issues);
  const executable = expectString(obj['executable'], `${pathStr}.executable`, issues);
  if (id === undefined || executable === undefined) valid = false;

  const args = Array.isArray(obj['args'])
    ? (obj['args'] as unknown[])
    : undefined;
  if (!Array.isArray(obj['args'])) {
    issue(issues, `${pathStr}.args`, 'Expected array');
    valid = false;
  } else if (args!.some((a) => typeof a !== 'string')) {
    issue(issues, `${pathStr}.args`, 'Entries must be strings');
    valid = false;
  }

  if (obj['type'] !== undefined && obj['type'] !== 'command' && obj['type'] !== 'probe' &&
      obj['type'] !== 'service_start' && obj['type'] !== 'service_stop') {
    issue(issues, `${pathStr}.type`, `Invalid step type "${String(obj['type'])}"`);
    valid = false;
  }

  const cwd = expectOptionalString(obj['cwd'], `${pathStr}.cwd`, issues);
  const timeout = expectOptionalNumber(obj['timeout_ms'], `${pathStr}.timeout_ms`, issues);
  if (timeout !== undefined && (timeout <= 0 || !Number.isInteger(timeout))) {
    issue(issues, `${pathStr}.timeout_ms`, 'Must be a positive integer');
    valid = false;
  }
  const readiness = expectOptionalString(obj['readiness_signal'], `${pathStr}.readiness_signal`, issues);
  const serviceRef = expectOptionalString(obj['service_ref'], `${pathStr}.service_ref`, issues);
  const expectedObservation = expectOptionalString(obj['expected_observation'], `${pathStr}.expected_observation`, issues);

  let notApplicable: { reason: string } | undefined;
  if (obj['not_applicable'] !== undefined) {
    const na = expectObject(obj['not_applicable'], `${pathStr}.not_applicable`, issues);
    if (na) {
      const reason = expectString(na['reason'], `${pathStr}.not_applicable.reason`, issues);
      if (reason === undefined) valid = false;
      else notApplicable = { reason };
    } else {
      valid = false;
    }
  }

  let expected: RuntimeProofStep['expected'];
  if (obj['expected'] !== undefined) {
    const exp = expectObject(obj['expected'], `${pathStr}.expected`, issues);
    if (exp) {
      const exitCode = exp['exit_code'];
      if (exitCode !== undefined && exitCode !== null &&
          (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
        issue(issues, `${pathStr}.expected.exit_code`, 'Must be an integer or null');
        valid = false;
      }
      const outputContains = expectOptionalString(exp['output_contains'], `${pathStr}.expected.output_contains`, issues);
      const outputMatches = expectOptionalString(exp['output_matches'], `${pathStr}.expected.output_matches`, issues);
      expected = {
        ...(exitCode !== undefined ? { exit_code: exitCode as number | null } : {}),
        ...(outputContains !== undefined ? { output_contains: outputContains } : {}),
        ...(outputMatches !== undefined ? { output_matches: outputMatches } : {}),
      };
    } else {
      valid = false;
    }
  }

  if (!valid) return undefined;
  return {
    id: id as string,
    ...(obj['type'] !== undefined
      ? { type: obj['type'] as RuntimeProofStep['type'] }
      : {}),
    executable: executable as string,
    args: (args as unknown[]) as string[],
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
    ...(readiness !== undefined ? { readiness_signal: readiness } : {}),
    ...(serviceRef !== undefined ? { service_ref: serviceRef } : {}),
    ...(expectedObservation !== undefined ? { expected_observation: expectedObservation } : {}),
    ...(notApplicable !== undefined ? { not_applicable: notApplicable } : {}),
    ...(expected !== undefined ? { expected } : {}),
  };
}

/** ProjectAcceptanceManifest validator (legacy ProjectAcceptanceManifestSchema). */
export function parseProjectAcceptanceManifest(value: unknown): ProjectAcceptanceManifest {
  const issues: SchemaIssue[] = [];
  const obj = expectObject(value, '', issues);
  if (!obj) throw new ProjectAcceptanceSchemaError(issues);

  const projectId = expectString(obj['project_id'], 'project_id', issues, { min: 1 });
  const expectedSnapshot = expectString(obj['expected_snapshot'], 'expected_snapshot', issues, { regex: HEX16 });
  const prdGoals = expectStringArray(obj['prd_goals'], 'prd_goals', issues);
  const criteria = expectStringArray(obj['acceptance_criteria'], 'acceptance_criteria', issues);
  const stageReceiptsRaw = expectNonEmptyArray(obj['stage_receipts'], 'stage_receipts', issues);
  const e2eStepsRaw = expectNonEmptyArray(obj['e2e_steps'], 'e2e_steps', issues);
  const compiledAt = expectOptionalString(obj['compiled_at'], 'compiled_at', issues);

  const stageReceipts: StageReceiptEntry[] = [];
  if (stageReceiptsRaw) {
    for (let i = 0; i < stageReceiptsRaw.length; i++) {
      const sr = expectObject(stageReceiptsRaw[i], `stage_receipts[${i}]`, issues);
      if (!sr) continue;
      let valid = true;
      const sid = expectString(sr['stage_id'], `stage_receipts[${i}].stage_id`, issues, { min: 1 });
      const sm = parsePathDigestRef(sr['stage_manifest'], `stage_receipts[${i}].stage_manifest`, issues);
      const rr = parsePathDigestRef(sr['review_receipt'], `stage_receipts[${i}].review_receipt`, issues);
      const gr = parsePathDigestRef(sr['gate_receipt'], `stage_receipts[${i}].gate_receipt`, issues);
      if (sid === undefined || sm === undefined || rr === undefined || gr === undefined) valid = false;
      if (valid) stageReceipts.push({ stage_id: sid as string, stage_manifest: sm!, review_receipt: rr!, gate_receipt: gr! });
    }
  }

  const e2eSteps: RuntimeProofStep[] = [];
  if (e2eStepsRaw) {
    for (let i = 0; i < e2eStepsRaw.length; i++) {
      const step = parseRuntimeProofStep(e2eStepsRaw[i], `e2e_steps[${i}]`, issues);
      if (step) e2eSteps.push(step);
    }
  }

  // Uniqueness superRefines (legacy superRefine).
  if (stageReceipts.length > 0) {
    const ids = stageReceipts.map((s) => s.stage_id);
    if (new Set(ids).size !== ids.length) {
      issue(issues, 'stage_receipts', 'Duplicate stage_id is not allowed');
    }
  }
  if (criteria && criteria.length > 0) {
    if (new Set(criteria).size !== criteria.length) {
      issue(issues, 'acceptance_criteria', 'Duplicate acceptance criteria is not allowed');
    }
  }

  if (issues.length > 0) throw new ProjectAcceptanceSchemaError(issues);
  return {
    project_id: projectId as string,
    expected_snapshot: expectedSnapshot as string,
    prd_goals: prdGoals as string[],
    acceptance_criteria: criteria as string[],
    stage_receipts: stageReceipts,
    e2e_steps: e2eSteps,
    ...(compiledAt !== undefined ? { compiled_at: compiledAt } : {}),
  };
}

/** ProjectE2EReceipt payload validator (legacy ProjectE2EReceiptSchema + PASS superRefine). */
export function parseProjectE2EReceipt(value: unknown): ProjectE2EReceipt {
  const issues: SchemaIssue[] = [];
  const obj = expectObject(value, '', issues);
  if (!obj) throw new ProjectAcceptanceSchemaError(issues);

  const projectId = expectString(obj['project_id'], 'project_id', issues, { min: 1 });
  const verdict = obj['verdict'];
  if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'BLOCKED') {
    issue(issues, 'verdict', `Expected "PASS" | "FAIL" | "BLOCKED", got ${JSON.stringify(verdict)}`);
  }
  const snapshot = expectString(obj['snapshot'], 'snapshot', issues, { regex: HEX16 });
  const manifestDigest = expectString(obj['manifest_digest'], 'manifest_digest', issues, { regex: HEX16 });
  const expectedSnapshot = expectString(obj['expected_snapshot'], 'expected_snapshot', issues, { regex: HEX16 });
  const executedSnapshot = expectString(obj['executed_snapshot'], 'executed_snapshot', issues, { regex: HEX16 });
  const stepsRaw = expectNonEmptyArray(obj['steps'], 'steps', issues);
  const cleanupRaw = expectObject(obj['service_cleanup'], 'service_cleanup', issues);
  const createdAt = expectString(obj['created_at'], 'created_at', issues);

  const steps: E2EStepResult[] = [];
  if (stepsRaw) {
    for (let i = 0; i < stepsRaw.length; i++) {
      const st = expectObject(stepsRaw[i], `steps[${i}]`, issues);
      if (!st) continue;
      let valid = true;
      const stepId = expectString(st['step_id'], `steps[${i}].step_id`, issues);
      const exitCode = st['exit_code'];
      if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
        issue(issues, `steps[${i}].exit_code`, 'Must be an integer or null');
        valid = false;
      }
      const observations = expectOptionalString(st['observations'], `steps[${i}].observations`, issues);
      const skipped = st['skipped'];
      if (skipped !== undefined && typeof skipped !== 'boolean') {
        issue(issues, `steps[${i}].skipped`, 'Must be a boolean');
        valid = false;
      }
      if (stepId === undefined) valid = false;
      if (valid) steps.push({
        step_id: stepId as string,
        exit_code: exitCode as number | null,
        ...(observations !== undefined ? { observations } : {}),
        ...(skipped !== undefined ? { skipped: skipped as boolean } : {}),
      });
    }
  }

  let serviceCleanup: ServiceCleanupResultShape | undefined;
  if (cleanupRaw) {
    serviceCleanup = parseServiceCleanup(cleanupRaw, 'service_cleanup', issues);
  }

  // PASS superRefine (legacy): non-skipped steps exist, all exit 0, clean
  // service_cleanup.
  if (verdict === 'PASS') {
    if (steps.length > 0) {
      const nonSkipped = steps.filter((s) => !s.skipped);
      if (nonSkipped.length === 0) {
        issue(issues, 'steps', 'PASS requires at least one non-skipped step');
      }
      for (const step of nonSkipped) {
        if (step.exit_code !== 0) {
          issue(issues, `steps.${step.step_id}.exit_code`, `PASS requires exit_code 0 for step "${step.step_id}", got ${step.exit_code}`);
        }
      }
    }
    if (serviceCleanup) {
      if (serviceCleanup.failed.length > 0) {
        issue(issues, 'service_cleanup.failed', 'PASS requires no service cleanup failures');
      }
      if (serviceCleanup.remainingPids.length > 0) {
        issue(issues, 'service_cleanup.remainingPids', 'PASS requires no remaining PIDs after cleanup');
      }
    }
  }

  if (issues.length > 0) throw new ProjectAcceptanceSchemaError(issues);
  return {
    project_id: projectId as string,
    verdict: verdict as ProjectE2EReceipt['verdict'],
    snapshot: snapshot as string,
    manifest_digest: manifestDigest as string,
    expected_snapshot: expectedSnapshot as string,
    executed_snapshot: executedSnapshot as string,
    steps,
    service_cleanup: serviceCleanup as ServiceCleanupResultShape,
    created_at: createdAt as string,
  };
}

function parseServiceCleanup(
  value: Record<string, unknown>,
  pathStr: string,
  issues: SchemaIssue[],
): ServiceCleanupResultShape | undefined {
  let valid = true;
  const cleaned = Array.isArray(value['cleaned']) ? value['cleaned'] : undefined;
  if (!Array.isArray(value['cleaned']) || (value['cleaned'] as unknown[]).some((c) => typeof c !== 'string')) {
    issue(issues, `${pathStr}.cleaned`, 'Must be an array of strings');
    valid = false;
  }
  const failed = Array.isArray(value['failed']) ? value['failed'] : undefined;
  if (!Array.isArray(value['failed'])) {
    issue(issues, `${pathStr}.failed`, 'Must be an array');
    valid = false;
  } else {
    for (let i = 0; i < failed!.length; i++) {
      const f = expectObject(failed![i], `${pathStr}.failed[${i}]`, issues);
      if (!f) {
        valid = false;
        continue;
      }
      const service = expectString(f['service'], `${pathStr}.failed[${i}].service`, issues);
      const pid = f['pid'];
      if (typeof pid !== 'number' || !Number.isInteger(pid)) {
        issue(issues, `${pathStr}.failed[${i}].pid`, 'Must be an integer');
        valid = false;
      }
      const reason = expectString(f['reason'], `${pathStr}.failed[${i}].reason`, issues);
      if (service === undefined || reason === undefined) valid = false;
    }
  }
  const remainingPids = Array.isArray(value['remainingPids']) ? value['remainingPids'] : undefined;
  if (!Array.isArray(value['remainingPids']) || (value['remainingPids'] as unknown[]).some((p) => typeof p !== 'number')) {
    issue(issues, `${pathStr}.remainingPids`, 'Must be an array of numbers');
    valid = false;
  }
  if (!valid) return undefined;
  return {
    cleaned: cleaned as string[],
    failed: failed as Array<{ service: string; pid: number; reason: string }>,
    remainingPids: remainingPids as number[],
  };
}

/** StageReviewReceipt validator (legacy StageReviewReceiptSchema). */
export function parseStageReviewReceipt(value: unknown): StageReviewReceipt {
  const issues: SchemaIssue[] = [];
  const obj = expectObject(value, '', issues);
  if (!obj) throw new ProjectAcceptanceSchemaError(issues);

  const stageId = expectString(obj['stage_id'], 'stage_id', issues, { min: 1 });
  const verdict = obj['verdict'];
  if (verdict !== 'ACCEPTED' && verdict !== 'REJECTED' && verdict !== 'BLOCKED') {
    issue(issues, 'verdict', `Expected "ACCEPTED" | "REJECTED" | "BLOCKED", got ${JSON.stringify(verdict)}`);
  }
  const snapshot = expectString(obj['snapshot'], 'snapshot', issues, { regex: HEX16 });
  const manifestDigest = expectString(obj['manifest_digest'], 'manifest_digest', issues, { regex: HEX16 });
  const gateRef = parsePathDigestRef(obj['stage_gate_receipt'], 'stage_gate_receipt', issues);
  const reviewer = expectString(obj['reviewer'], 'reviewer', issues, { min: 1 });
  const reviewedAt = expectString(obj['reviewed_at'], 'reviewed_at', issues);

  let findings: Array<{ category: string; description: string }> = [];
  if (obj['findings'] !== undefined) {
    if (!Array.isArray(obj['findings'])) {
      issue(issues, 'findings', 'Must be an array');
    } else {
      findings = [];
      for (let i = 0; i < (obj['findings'] as unknown[]).length; i++) {
        const f = expectObject((obj['findings'] as unknown[])[i], `findings[${i}]`, issues);
        if (f) {
          const cat = expectString(f['category'], `findings[${i}].category`, issues, { min: 1 });
          const desc = expectString(f['description'], `findings[${i}].description`, issues, { min: 1 });
          if (cat && desc) findings.push({ category: cat, description: desc });
        }
      }
    }
  }

  if (issues.length > 0) throw new ProjectAcceptanceSchemaError(issues);
  return {
    stage_id: stageId as string,
    verdict: verdict as StageReviewReceipt['verdict'],
    snapshot: snapshot as string,
    manifest_digest: manifestDigest as string,
    stage_gate_receipt: gateRef as { path: string; digest: string },
    findings,
    reviewer: reviewer as string,
    reviewed_at: reviewedAt as string,
  };
}

/** StageGateReceipt validator (legacy StageGateReceipt). */
export function parseStageGateReceipt(value: unknown): StageGateReceipt {
  const issues: SchemaIssue[] = [];
  const obj = expectObject(value, '', issues);
  if (!obj) throw new ProjectAcceptanceSchemaError(issues);

  const stageId = expectString(obj['stage_id'], 'stage_id', issues, { min: 1 });
  const snapshot = expectString(obj['snapshot'], 'snapshot', issues, { regex: HEX16 });
  const manifestDigest = expectString(obj['manifest_digest'], 'manifest_digest', issues, { regex: HEX16 });
  const platform = expectString(obj['platform'], 'platform', issues);
  const verdict = obj['verdict'];
  if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'BLOCKED') {
    issue(issues, 'verdict', `Expected "PASS" | "FAIL" | "BLOCKED", got ${JSON.stringify(verdict)}`);
  }
  const steps = Array.isArray(obj['steps']) ? obj['steps'] : undefined;
  if (!Array.isArray(obj['steps'])) issue(issues, 'steps', 'Must be an array');
  const cleanupRaw = expectObject(obj['service_cleanup'], 'service_cleanup', issues);
  const timestampsRaw = expectObject(obj['timestamps'], 'timestamps', issues);

  let serviceCleanup: ServiceCleanupResultShape | undefined;
  if (cleanupRaw) serviceCleanup = parseServiceCleanup(cleanupRaw, 'service_cleanup', issues);

  let startedAt: string | undefined;
  let completedAt: string | undefined;
  if (timestampsRaw) {
    startedAt = expectString(timestampsRaw['started_at'], 'timestamps.started_at', issues);
    completedAt = expectString(timestampsRaw['completed_at'], 'timestamps.completed_at', issues);
  }

  if (issues.length > 0) throw new ProjectAcceptanceSchemaError(issues);
  return {
    stage_id: stageId as string,
    snapshot: snapshot as string,
    manifest_digest: manifestDigest as string,
    ...(obj['completed_slice_ids'] !== undefined
      ? { completed_slice_ids: obj['completed_slice_ids'] as string[] }
      : {}),
    ...(obj['slice_complete_facts'] !== undefined
      ? { slice_complete_facts: obj['slice_complete_facts'] as Array<Record<string, unknown>> }
      : {}),
    ...(obj['manifest_path'] !== undefined ? { manifest_path: obj['manifest_path'] as string } : {}),
    platform: platform as string,
    verdict: verdict as StageGateReceipt['verdict'],
    steps: steps as Array<{ id: string; exit_code: number | null; skipped?: boolean; observations?: string }>,
    service_cleanup: serviceCleanup as ServiceCleanupResultShape,
    timestamps: { started_at: startedAt as string, completed_at: completedAt as string },
  };
}

/** ProjectReviewResult validator (legacy ProjectReviewResultSchema + criteria uniqueness). */
export function parseProjectReviewResult(value: unknown): ProjectReviewResult {
  const issues: SchemaIssue[] = [];
  const obj = expectObject(value, '', issues);
  if (!obj) throw new ProjectAcceptanceSchemaError(issues);

  const verdict = obj['verdict'];
  if (verdict !== 'PROJECT_ACCEPTED' && verdict !== 'PROJECT_REJECTED' && verdict !== 'PROJECT_BLOCKED') {
    issue(issues, 'verdict', `Expected "PROJECT_ACCEPTED" | "PROJECT_REJECTED" | "PROJECT_BLOCKED", got ${JSON.stringify(verdict)}`);
  }
  const reviewer = expectString(obj['reviewer'], 'reviewer', issues, { min: 1 });
  const reviewedSnapshot = expectString(obj['reviewed_snapshot'], 'reviewed_snapshot', issues, { regex: HEX16 });
  const projectManifest = parsePathDigestRef(obj['project_manifest'], 'project_manifest', issues);
  const projectE2E = parsePathDigestRef(obj['project_e2e_receipt'], 'project_e2e_receipt', issues);
  const reviewedAt = expectString(obj['reviewed_at'], 'reviewed_at', issues);

  const criteriaRaw = Array.isArray(obj['criteria_results']) ? obj['criteria_results'] as unknown[] : undefined;
  if (!Array.isArray(obj['criteria_results'])) issue(issues, 'criteria_results', 'Must be an array');
  const criteriaResults: Array<{ criteria: string; passed: boolean; notes?: string }> = [];
  if (criteriaRaw) {
    for (let i = 0; i < criteriaRaw.length; i++) {
      const c = expectObject(criteriaRaw[i], `criteria_results[${i}]`, issues);
      if (!c) continue;
      const crit = expectString(c['criteria'], `criteria_results[${i}].criteria`, issues, { min: 1 });
      const passed = c['passed'];
      if (typeof passed !== 'boolean') {
        issue(issues, `criteria_results[${i}].passed`, 'Must be a boolean');
      }
      const notes = expectOptionalString(c['notes'], `criteria_results[${i}].notes`, issues);
      if (crit !== undefined && typeof passed === 'boolean') {
        criteriaResults.push({ criteria: crit, passed, ...(notes !== undefined ? { notes } : {}) });
      }
    }
    const critSet = new Set(criteriaResults.map((c) => c.criteria));
    if (critSet.size !== criteriaResults.length) {
      issue(issues, 'criteria_results', 'Duplicate criteria in reviewer result is not allowed');
    }
  }

  let findings: Array<{ category: string; description: string }> = [];
  if (obj['findings'] !== undefined) {
    if (!Array.isArray(obj['findings'])) {
      issue(issues, 'findings', 'Must be an array');
    } else {
      for (let i = 0; i < (obj['findings'] as unknown[]).length; i++) {
        const f = expectObject((obj['findings'] as unknown[])[i], `findings[${i}]`, issues);
        if (f) {
          const cat = expectString(f['category'], `findings[${i}].category`, issues, { min: 1 });
          const desc = expectString(f['description'], `findings[${i}].description`, issues, { min: 1 });
          if (cat && desc) findings.push({ category: cat, description: desc });
        }
      }
    }
  }

  let acceptedDeviations: string[] = [];
  if (obj['accepted_deviations'] !== undefined) {
    if (!Array.isArray(obj['accepted_deviations']) || (obj['accepted_deviations'] as unknown[]).some((d) => typeof d !== 'string')) {
      issue(issues, 'accepted_deviations', 'Must be an array of strings');
    } else {
      acceptedDeviations = obj['accepted_deviations'] as string[];
    }
  }

  if (issues.length > 0) throw new ProjectAcceptanceSchemaError(issues);
  return {
    verdict: verdict as ProjectReviewResult['verdict'],
    reviewer: reviewer as string,
    reviewed_snapshot: reviewedSnapshot as string,
    project_manifest: projectManifest as { path: string; digest: string },
    project_e2e_receipt: projectE2E as { path: string; digest: string },
    criteria_results: criteriaResults,
    findings,
    accepted_deviations: acceptedDeviations,
    reviewed_at: reviewedAt as string,
  };
}

// ============================================================
// Shared helpers
// ============================================================

/**
 * Compute the git-based project snapshot: sha256 over `HEAD` + sorted
 * `git status --porcelain` output, truncated to 16 hex chars (legacy
 * 16-char behavior).
 *
 * Difference vs. legacy: the legacy computeSnapshot hashed the directory
 * tree contents (skipping .git / node_modules / hidden dirs); the git-based
 * snapshot is deterministic for a given commit + work-tree state, cheaper,
 * and equally content-aware via the porcelain status.
 *
 * @throws {Error} when `projectRoot` is not inside a git work tree or git is
 *         unavailable (fail closed — a project snapshot cannot be guessed).
 */
export function computeSnapshot(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  let head: string;
  let status: string;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? 'git executable is unavailable'
      : 'projectRoot is not inside a git work tree (or HEAD is unborn)';
    throw new Error(`PROJECT_SNAPSHOT_UNAVAILABLE: ${reason} for ${root}`);
  }
  try {
    status = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    status = '';
  }
  const lines = status.split('\n').filter((l) => l.length > 0).sort();
  const hash = crypto.createHash('sha256');
  hash.update(`HEAD:${head}\n`);
  for (const line of lines) hash.update(`${line}\n`);
  return hash.digest('hex').slice(0, 16);
}

/** Recursively sort object keys for canonical JSON (legacy canonical-digest). */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Canonical (sorted-key) JSON digest, 16-char hex (legacy
 * computeCanonicalJsonDigest behavior). Computed over the VALIDATED object —
 * the pure-TS validators do not transform, so file content and digest are
 * consistent by construction.
 */
export function computeCanonicalJsonDigest(value: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(sortKeys(value)), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

/** sha256 of a file's bytes, 16-char hex (legacy computeFileDigest behavior). */
export function fileDigest16(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
}

/** Read + JSON.parse a file; returns null on any failure. */
function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================
// Topology validation (legacy validateRuntimeProofTopology, behavior authority)
// ============================================================

export interface TopologyError {
  type: 'DUPLICATE_STEP_ID' | 'SERVICE_START_WITHOUT_STOP' | 'STOP_REF_MISSING' | 'STOP_BEFORE_START';
  message: string;
}

/** Validate E2E step topology: unique ids + service_start/service_stop pairing. */
export function validateE2ETopology(steps: readonly RuntimeProofStep[]): TopologyError[] {
  const errors: TopologyError[] = [];
  if (steps.length === 0) return errors;

  const seenStepIds = new Set<string>();
  for (const step of steps) {
    if (seenStepIds.has(step.id)) {
      errors.push({ type: 'DUPLICATE_STEP_ID', message: `Duplicate step ID: "${step.id}"` });
    }
    seenStepIds.add(step.id);
  }

  const serviceStartIds = new Set(
    steps.filter((s) => s.type === 'service_start').map((s) => s.id),
  );
  const serviceStopInfos = steps
    .filter((s) => s.type === 'service_stop')
    .map((s) => ({ id: s.id, ref: s.service_ref ?? s.id }));

  for (const startId of serviceStartIds) {
    const hasStop = serviceStopInfos.some((s) => s.ref === startId);
    if (!hasStop) {
      errors.push({ type: 'SERVICE_START_WITHOUT_STOP', message: `service_start "${startId}" has no matching service_stop` });
    }
  }
  for (const sInfo of serviceStopInfos) {
    if (!serviceStartIds.has(sInfo.ref)) {
      errors.push({ type: 'STOP_REF_MISSING', message: `service_stop "${sInfo.id}" references non-existent service_start "${sInfo.ref}"` });
    }
    const startIdx = steps.findIndex((s) => s.id === sInfo.ref);
    const stopIdx = steps.findIndex((s) => s.id === sInfo.id);
    if (startIdx >= 0 && stopIdx >= 0 && stopIdx < startIdx) {
      errors.push({ type: 'STOP_BEFORE_START', message: `service_stop "${sInfo.id}" appears before its service_start "${sInfo.ref}"` });
    }
  }
  return errors;
}

// ============================================================
// Step execution engine (B1a Process Runner; parity with run-gate.ts)
// ============================================================

/** Internal executed-step result (superset of the receipt's step shape). */
interface ExecutedStep {
  step_id: string;
  exit_code: number | null;
  observations?: string;
  skipped?: boolean;
  passed: boolean;
  error?: string;
}

/** expected.exit_code oracle: absent → 0; null → any; number → exact. */
function expectedExitCode(step: RuntimeProofStep): number | null {
  const expected = step.expected;
  if (expected === undefined) return 0;
  const value = expected['exit_code'];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : 0;
}

/** Execute one E2E step (not_applicable / service_start / service_stop / command / probe). */
async function executeE2EStep(
  step: RuntimeProofStep,
  projectRoot: string,
): Promise<ExecutedStep> {
  if (step.not_applicable?.reason) {
    return {
      step_id: step.id,
      exit_code: 0,
      observations: `Skipped: ${step.not_applicable.reason}`,
      skipped: true,
      passed: true,
    };
  }

  const cwd = path.isAbsolute(step.cwd ?? '.')
    ? step.cwd as string
    : path.resolve(projectRoot, step.cwd ?? '.');

  if (step.type === 'service_start') {
    return executeServiceStart(step, cwd);
  }
  if (step.type === 'service_stop') {
    return executeServiceStop(step);
  }
  return executeCommandStep(step, cwd);
}

/** service_start: spawnService → registerService → waitForReadiness (stop on failure). */
async function executeServiceStart(step: RuntimeProofStep, cwd: string): Promise<ExecutedStep> {
  const startTime = Date.now();
  try {
    const handle = await spawnService({
      executable: step.executable,
      args: step.args,
      cwd,
    });
    registerService(step.id, handle);

    let readinessMs = 0;
    if (step.readiness_signal) {
      const readyStart = Date.now();
      const readiness = await waitForReadiness(handle, step.readiness_signal, step.timeout_ms ?? 300000);
      readinessMs = Date.now() - readyStart;
      if (!readiness.ready) {
        try {
          await stopService(handle);
        } catch {
          // best-effort — the readiness failure below is the primary error
        }
        if (readiness.exited) {
          return {
            step_id: step.id,
            exit_code: readiness.exitCode,
            passed: false,
            error: `Step "${step.id}" (service_start) process exited (code ${readiness.exitCode}) before readiness signal "${step.readiness_signal}" was found. Stdout: ${handle.getStdout().slice(0, 500)}`,
          };
        }
        return {
          step_id: step.id,
          exit_code: null,
          passed: false,
          error: `Step "${step.id}" (service_start) readiness signal "${step.readiness_signal}" not found within ${step.timeout_ms ?? 300000}ms. Stdout: ${handle.getStdout().slice(0, 500)}`,
        };
      }
    }

    const durationMs = Date.now() - startTime;
    const observations = [
      `Service started, PID ${handle.pid}`,
      step.readiness_signal ? `Readiness signal found after ${readinessMs}ms` : '',
    ].filter(Boolean).join(' | ');
    return { step_id: step.id, exit_code: 0, observations, passed: true };
  } catch (err) {
    return {
      step_id: step.id,
      exit_code: null,
      passed: false,
      error: `Step "${step.id}" (service_start) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** service_stop: registry lookup by service_ref (or step.id) + tree stop. */
async function executeServiceStop(step: RuntimeProofStep): Promise<ExecutedStep> {
  const ref = step.service_ref ?? step.id;
  const service = getRegisteredService(ref);
  if (service === undefined) {
    return {
      step_id: step.id,
      exit_code: null,
      passed: false,
      error: `Step "${step.id}" (service_stop): no registered service found for ref "${ref}". Ensure the corresponding service_start step ran successfully.`,
    };
  }
  try {
    const stopped = await stopService(ref);
    if (!stopped) {
      return {
        step_id: step.id,
        exit_code: null,
        passed: false,
        error: `Step "${step.id}" (service_stop): registered service "${ref}" not found or already stopped`,
      };
    }
    return { step_id: step.id, exit_code: 0, observations: `Service stopped (PID ${service.pid})`, passed: true };
  } catch (err) {
    return {
      step_id: step.id,
      exit_code: null,
      passed: false,
      error: `Step "${step.id}" (service_stop) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * command / probe: one-shot runProcess (bounded output, per-step timeout with
 * process-tree cleanup) + the expected oracle: exit_code (absent → 0, null →
 * any, number → exact), output_contains, output_matches, readiness_signal and
 * expected_observation over merged stdout+stderr. Timeout always FAILs.
 */
async function executeCommandStep(step: RuntimeProofStep, cwd: string): Promise<ExecutedStep> {
  const expected = expectedExitCode(step);
  try {
    const result = await runProcess({
      executable: step.executable,
      args: step.args,
      cwd,
      timeoutMs: step.timeout_ms,
    });

    const observations = [
      result.stdout.length > 0 ? `stdout: ${result.stdout.slice(0, 1000)}` : '',
      result.stderr.length > 0 ? `stderr: ${result.stderr.slice(0, 1000)}` : '',
    ].filter(Boolean).join(' | ').slice(0, 2000) || undefined;

    if (result.timedOut) {
      return {
        step_id: step.id,
        exit_code: null,
        passed: false,
        error: `Step "${step.id}" timed out after ${step.timeout_ms}ms` + (result.stderr ? ` — stderr: ${result.stderr.slice(0, 500)}` : ''),
      };
    }

    if (expected !== null && result.exitCode !== expected) {
      return {
        step_id: step.id,
        exit_code: result.exitCode,
        passed: false,
        error: `Step "${step.id}" exited ${result.exitCode}, expected ${expected}` + (result.stderr ? ` — stderr: ${result.stderr.slice(0, 500)}` : ''),
      };
    }

    const expectedBlock = step.expected;
    if (expectedBlock?.output_contains) {
      if (!result.stdout.includes(expectedBlock.output_contains)) {
        return {
          step_id: step.id,
          exit_code: result.exitCode,
          passed: false,
          error: `Step "${step.id}" stdout does not contain expected text "${expectedBlock.output_contains}". Stdout: ${result.stdout.slice(0, 500)}`,
        };
      }
    }
    if (expectedBlock?.output_matches) {
      try {
        const regex = new RegExp(expectedBlock.output_matches);
        if (!regex.test(result.stdout)) {
          return {
            step_id: step.id,
            exit_code: result.exitCode,
            passed: false,
            error: `Step "${step.id}" stdout does not match expected regex /${expectedBlock.output_matches}/. Stdout: ${result.stdout.slice(0, 500)}`,
          };
        }
      } catch (regexErr) {
        return {
          step_id: step.id,
          exit_code: result.exitCode,
          passed: false,
          error: `Step "${step.id}" has invalid output_matches regex: ${String(regexErr)}`,
        };
      }
    }
    if (step.readiness_signal) {
      const combined = result.stdout + result.stderr;
      if (!combined.includes(step.readiness_signal)) {
        return {
          step_id: step.id,
          exit_code: result.exitCode,
          passed: false,
          error: `Step "${step.id}" readiness signal "${step.readiness_signal}" not found in output. Stdout: ${result.stdout.slice(0, 500)}`,
        };
      }
    }
    if (step.expected_observation) {
      const combined = result.stdout + result.stderr;
      if (!combined.includes(step.expected_observation)) {
        return {
          step_id: step.id,
          exit_code: result.exitCode,
          passed: false,
          error: `Step "${step.id}" expected observation "${step.expected_observation}" not found. Stdout: ${result.stdout.slice(0, 500)}`,
        };
      }
    }

    return { step_id: step.id, exit_code: result.exitCode, observations, passed: true };
  } catch (err) {
    // SpawnValidationError (shell prohibition) or unexpected runner failure.
    return {
      step_id: step.id,
      exit_code: null,
      passed: false,
      error: `Step "${step.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Mandatory cleanup at the end of a run (PASS or FAIL): stop every
 * still-registered service. A service stopped by cleanup but with a DECLARED
 * service_stop step counts as "explicit stop was missed" → failure (legacy
 * run-stage.ts semantics); cleanup failures / remaining PIDs also fail.
 */
async function finalizeE2ECleanup(
  steps: readonly RuntimeProofStep[],
  errors: string[],
): Promise<ServiceCleanupResultShape> {
  const serviceStopRefs = new Set(
    steps.filter((s) => s.type === 'service_stop').map((s) => s.service_ref ?? s.id),
  );
  const serviceCleanup: ServiceCleanupResult = await cleanupServices();

  for (const name of serviceCleanup.cleaned) {
    if (serviceStopRefs.has(name)) {
      errors.push(
        `Service "${name}" was still running at final cleanup but has a declared service_stop step. The explicit stop was missed. This is a FAIL.`,
      );
    }
  }
  for (const f of serviceCleanup.failed) {
    errors.push(`Service cleanup failures: ${f.service} (PID ${f.pid}): ${f.reason}`);
  }
  for (const pid of serviceCleanup.remainingPids) {
    errors.push(`Services still running after cleanup: PID ${pid}. Cleanup failure counts as FAIL.`);
  }
  return serviceCleanup;
}

// ============================================================
// compile — COMPILE_ACCEPTANCE
// ============================================================

export interface CompileProjectAcceptanceInput {
  readonly project_root: string;
  readonly project_id: string;
  readonly prd_goals?: string[];
  readonly acceptance_criteria?: string[];
  readonly stage_receipts: unknown[];
  readonly e2e_steps?: unknown[];
}

export interface CompileProjectAcceptanceResult {
  readonly success: boolean;
  readonly manifest?: ProjectAcceptanceManifest;
  readonly manifestDigest?: string;
  readonly outputPath?: string;
  readonly errors: readonly string[];
}

/**
 * Build the ProjectAcceptanceManifest (legacy compile-project-acceptance.ts,
 * behavior authority):
 *   1. input shape + project_root existence checks;
 *   2. expected_snapshot = computeSnapshot(project_root) (git-based);
 *   3. assemble the manifest (prd_goals / acceptance_criteria / e2e_steps
 *      default to []); stage_receipts must be a non-empty array;
 *   4. local schema validation — any violation is a structured error, no file
 *      is written;
 *   5. canonical manifest digest over the validated manifest;
 *   6. write the manifest JSON to the output path.
 *
 * Difference vs. legacy: compile refuses empty e2e_steps (the manifest schema
 * requires ≥ 1 E2E step; the legacy CLI wrote the file only after schema
 * validation, which equally rejected it — here the file is never created).
 */
export function compileProjectAcceptance(
  input: unknown,
  outputPath: string,
): CompileProjectAcceptanceResult {
  const errors: string[] = [];
  const obj = isObject(input) ? input : null;
  if (!obj) {
    return { success: false, errors: ['Input must be a JSON object'] };
  }

  const projectRoot = obj['project_root'];
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { success: false, errors: ['Input must contain "project_root" field'] };
  }
  if (!fs.existsSync(projectRoot)) {
    return { success: false, errors: [`Project root not found: ${projectRoot}`] };
  }

  if (!Array.isArray(obj['stage_receipts']) || (obj['stage_receipts'] as unknown[]).length === 0) {
    return { success: false, errors: ['Input must contain "stage_receipts" array with at least one entry'] };
  }

  let expectedSnapshot: string;
  try {
    expectedSnapshot = computeSnapshot(projectRoot);
  } catch (err) {
    return { success: false, errors: [err instanceof Error ? err.message : String(err)] };
  }

  const projectId = obj['project_id'];
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { success: false, errors: ['Input must contain a non-empty "project_id" field'] };
  }

  const manifest: ProjectAcceptanceManifest = {
    project_id: projectId,
    expected_snapshot: expectedSnapshot,
    prd_goals: Array.isArray(obj['prd_goals']) ? obj['prd_goals'] as string[] : [],
    acceptance_criteria: Array.isArray(obj['acceptance_criteria']) ? obj['acceptance_criteria'] as string[] : [],
    stage_receipts: obj['stage_receipts'] as unknown as StageReceiptEntry[],
    e2e_steps: Array.isArray(obj['e2e_steps']) ? obj['e2e_steps'] as unknown as RuntimeProofStep[] : [],
    compiled_at: new Date().toISOString(),
  };

  let validated: ProjectAcceptanceManifest;
  try {
    validated = parseProjectAcceptanceManifest(manifest);
  } catch (err) {
    if (err instanceof ProjectAcceptanceSchemaError) {
      errors.push('Generated manifest failed schema validation:', ...err.issues.map((i) => `${i.path}: ${i.message}`));
    } else {
      errors.push(`Generated manifest failed schema validation: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { success: false, errors };
  }

  const manifestDigest = computeCanonicalJsonDigest(validated);

  try {
    fs.writeFileSync(outputPath, JSON.stringify(validated, null, 2), 'utf-8');
  } catch (err) {
    return { success: false, errors: [`Cannot write manifest to ${outputPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }

  return {
    success: true,
    manifest: validated,
    manifestDigest,
    outputPath: path.resolve(outputPath),
    errors: [],
  };
}

// ============================================================
// run — RUN_E2E
// ============================================================

export interface RunProjectAcceptanceE2EOptions {
  /** Project root for snapshot + step cwd resolution (default process.cwd()). */
  readonly projectRoot?: string;
  /**
   * Receipt directory for the Project E2E Gate Receipt (kernel writeReceipt).
   * Defaults to the canonical `project/` category:
   * projectReceiptDir(projectRoot).
   */
  readonly receiptDir?: string;
}

export interface RunProjectAcceptanceE2EResult {
  readonly success: boolean;
  readonly verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  /** The E2E receipt payload (legacy ProjectE2EReceipt content). */
  readonly receipt?: ProjectE2EReceipt;
  /** Absolute path of the written kernel Receipt envelope file. */
  readonly receiptPath?: string;
  /** Kernel content digest (64-hex) of the written envelope. */
  readonly receiptDigest?: string;
  readonly errors: readonly string[];
}

/**
 * Execute a Project Acceptance E2E run (legacy runProjectAcceptance, behavior
 * authority):
 *   0. zero steps / all-skipped rejection;
 *   1. step topology validation (duplicate ids, service start/stop pairing);
 *   2. snapshot staleness check (expected_snapshot must equal the current
 *      project snapshot);
 *   3. sequential step execution through the B1a Process Runner (command /
 *      probe via runProcess with the expected oracle; service_start /
 *      service_stop via the service lifecycle; not_applicable skipped);
 *      execution stops at the first failed step;
 *   4. mandatory service cleanup (PASS and FAIL alike);
 *   5. verdict = PASS when there are no errors, else FAIL (BLOCKED is
 *      reserved by the schema; the legacy runner never produced it either);
 *   6. persist the Project E2E Gate Receipt via kernel writeReceipt into the
 *      canonical project/ category: type PROJECT_E2E_PASS / FAIL / BLOCKED
 *      per verdict, envelope stage_id = project_id (kernel requires a
 *      non-empty stage_id), payload = the legacy ProjectE2EReceipt content.
 *
 * The receipt is written on PASS AND on FAIL (evidence留档 — the old runtime
 * wrote the FAIL receipt too); the caller decides the exit code from
 * `success` (a FAIL verdict never pretends to be a PASS).
 */
export async function runProjectAcceptanceE2E(
  manifestInput: unknown,
  options?: RunProjectAcceptanceE2EOptions,
): Promise<RunProjectAcceptanceE2EResult> {
  const errors: string[] = [];

  let manifest: ProjectAcceptanceManifest;
  try {
    manifest = parseProjectAcceptanceManifest(manifestInput);
  } catch (err) {
    const issues = err instanceof ProjectAcceptanceSchemaError ? err.issues : [];
    return {
      success: false,
      verdict: 'BLOCKED',
      errors: issues.length > 0
        ? [`Manifest schema validation failed:`, ...issues.map((i) => `${i.path}: ${i.message}`)]
        : [`Manifest schema validation failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const projectRoot = path.resolve(options?.projectRoot ?? process.cwd());

  // ── 0. Zero-step / all-skipped rejection ──
  if (manifest.e2e_steps.length === 0) {
    return {
      success: false,
      verdict: 'BLOCKED',
      errors: ['PROJECT_E2E_ZERO_STEPS: Project Acceptance requires at least one E2E step'],
    };
  }
  if (manifest.e2e_steps.every((s) => s.not_applicable?.reason)) {
    return {
      success: false,
      verdict: 'BLOCKED',
      errors: ['PROJECT_E2E_ALL_SKIPPED: All E2E steps are not_applicable; a proof with no evidence is not valid'],
    };
  }

  // ── 1. Topology ──
  const topologyErrors = validateE2ETopology(manifest.e2e_steps);
  if (topologyErrors.length > 0) {
    return {
      success: false,
      verdict: 'BLOCKED',
      errors: topologyErrors.map((e) => `[${e.type}] ${e.message}`),
    };
  }

  // ── 1b. Snapshot staleness ──
  let executedSnapshot: string;
  try {
    executedSnapshot = computeSnapshot(projectRoot);
  } catch (err) {
    return {
      success: false,
      verdict: 'BLOCKED',
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
  if (manifest.expected_snapshot !== executedSnapshot) {
    return {
      success: false,
      verdict: 'BLOCKED',
      errors: [
        `PROJECT_SOURCE_STALE: expected snapshot "${manifest.expected_snapshot}" does not match executed "${executedSnapshot}"`,
      ],
    };
  }

  // ── 2. Execute steps sequentially (stop at first failure) ──
  const executedSteps: ExecutedStep[] = [];
  for (const step of manifest.e2e_steps) {
    const result = await executeE2EStep(step, projectRoot);
    executedSteps.push(result);
    if (!result.passed && !result.skipped) break;
  }
  for (const step of executedSteps) {
    if (!step.passed && step.error !== undefined) errors.push(step.error);
  }

  // ── 3. Mandatory cleanup (PASS and FAIL alike) ──
  const serviceCleanup = await finalizeE2ECleanup(manifest.e2e_steps, errors);

  // ── 4. Verdict ──
  const verdict: ProjectE2EReceipt['verdict'] = errors.length === 0 ? 'PASS' : 'FAIL';

  // ── 5. Build receipt (legacy ProjectE2EReceipt content) ──
  const receipt: ProjectE2EReceipt = {
    project_id: manifest.project_id,
    verdict,
    snapshot: executedSnapshot,
    manifest_digest: computeCanonicalJsonDigest(manifest),
    expected_snapshot: manifest.expected_snapshot,
    executed_snapshot: executedSnapshot,
    steps: executedSteps.map((s) => ({
      step_id: s.step_id,
      exit_code: s.exit_code,
      ...(s.observations !== undefined ? { observations: s.observations } : {}),
      ...(s.skipped !== undefined ? { skipped: s.skipped } : {}),
    })),
    service_cleanup: serviceCleanup,
    created_at: new Date().toISOString(),
  };

  // ── 6. Persist via kernel writeReceipt (immutable + digest + chain) ──
  const receiptDir = path.resolve(options?.receiptDir ?? projectReceiptDir(projectRoot));
  const envelope = {
    version: 1 as const,
    type: PROJECT_E2E_TYPE_BY_VERDICT[verdict],
    stage_id: manifest.project_id,
    timestamp: receipt.created_at,
    payload: receipt,
  };
  try {
    const written = writeReceipt(envelope, { receiptDir, tempDir: receiptDir });
    return {
      success: verdict === 'PASS',
      verdict,
      receipt,
      receiptPath: written.path,
      receiptDigest: written.digest,
      errors,
    };
  } catch (err) {
    errors.push(`Cannot write Project E2E Gate Receipt: ${err instanceof Error ? err.message : String(err)}`);
    return {
      success: false,
      verdict,
      receipt,
      errors,
    };
  }
}

// ============================================================
// finalize — FINALIZE_PROJECT_REVIEW
// ============================================================

export interface FinalizeProjectReviewInput {
  readonly manifestPath: string;
  readonly e2eReceiptPath: string;
  readonly reviewerResultPath: string;
  /** Receipt directory for the final Project Review Receipt (kernel writeReceipt). */
  readonly outputDir: string;
}

export interface FinalizeProjectReviewResult {
  readonly success: boolean;
  /** Absolute path of the written PROJECT_REVIEW_PASS envelope file. */
  readonly receiptPath?: string;
  /** Kernel content digest (64-hex) of the written envelope. */
  readonly receiptDigest?: string;
  readonly errors: readonly string[];
}

/**
 * Finalize the project review (legacy finalize-project-review.ts, behavior
 * authority — validation checklist kept verbatim):
 *   1. Manifest: exists, schema-valid, canonical digest + file digest;
 *   2. E2E gate receipt: exists, kernel-envelope valid, type matches the
 *      payload verdict (PROJECT_E2E_*), payload schema-valid, verdict PASS,
 *      project_id / manifest_digest / expected_snapshot / executed_snapshot
 *      bound to the manifest, at least one non-skipped step;
 *   3. Reviewer result: exists, schema-valid, verdict PROJECT_ACCEPTED,
 *      reviewed_snapshot bound, project_manifest.digest bound, the reviewer's
 *      e2e receipt file digest matches its declared digest AND the actual
 *      E2E file digest;
 *   4. Per-stage triple-binding: stage manifest (kernel-validated, canonical
 *      digest), stage review receipt (ACCEPTED, manifest_digest bound,
 *      stage_gate_receipt file-digest triple-bound to the manifest gate
 *      entry), stage gate receipt (PASS, manifest_digest bound);
 *   5. Criteria one-to-one coverage: exact length match, both-set equality,
 *      every criterion passed;
 *   6. Reviewer manifest path file digest matches the actual manifest.
 *
 * All checks pass → persist the Project Review Receipt via kernel
 * writeReceipt (type PROJECT_REVIEW_PASS, envelope stage_id = project_id,
 * payload = legacy WriteProjectReviewReceiptOptions content) with
 * previous_digest chained to the E2E gate receipt envelope digest
 * (PO-S02-C-03 chain semantics). Any violation → structured errors, exit
 * semantics left to the caller; nothing is written on failure.
 */
export function finalizeProjectReview(
  input: FinalizeProjectReviewInput,
): FinalizeProjectReviewResult {
  const errors: string[] = [];

  // ── 1. Manifest ──
  if (!fs.existsSync(input.manifestPath)) {
    return { success: false, errors: [`Manifest not found: ${input.manifestPath}`] };
  }
  const manifestRaw = readJsonFile(input.manifestPath);
  if (manifestRaw === null) {
    return { success: false, errors: [`Invalid Project Manifest: cannot parse ${input.manifestPath}`] };
  }
  let manifest: ProjectAcceptanceManifest;
  try {
    manifest = parseProjectAcceptanceManifest(manifestRaw);
  } catch (err) {
    return {
      success: false,
      errors: [`Invalid Project Manifest: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const manifestFileDigest = fileDigest16(input.manifestPath);
  const manifestDigest = computeCanonicalJsonDigest(manifest);

  // ── 2. E2E gate receipt ──
  if (!fs.existsSync(input.e2eReceiptPath)) {
    return { success: false, errors: [`E2E Receipt not found: ${input.e2eReceiptPath}`] };
  }
  const e2eRaw = readJsonFile(input.e2eReceiptPath);
  if (e2eRaw === null) {
    return { success: false, errors: [`Invalid E2E Receipt: cannot parse ${input.e2eReceiptPath}`] };
  }
  let e2eEnvelope: { digest: string; type: string; payload: Record<string, unknown> };
  try {
    const validated = validateReceipt(e2eRaw);
    e2eEnvelope = {
      digest: validated.digest,
      type: validated.type,
      payload: validated.payload,
    };
  } catch (err) {
    return {
      success: false,
      errors: [`Invalid E2E Receipt (kernel envelope): ${err instanceof SchemaValidationError ? err.message : String(err)}`],
    };
  }
  if (!PROJECT_E2E_TYPES.includes(e2eEnvelope.type)) {
    return { success: false, errors: [`E2E Receipt type "${e2eEnvelope.type}" is not a PROJECT_E2E_* gate receipt`] };
  }
  let e2e: ProjectE2EReceipt;
  try {
    e2e = parseProjectE2EReceipt(e2eEnvelope.payload);
  } catch (err) {
    return {
      success: false,
      errors: [`Invalid E2E Receipt payload: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  const e2eFileDigest = fileDigest16(input.e2eReceiptPath);

  if (e2e.verdict !== 'PASS') errors.push(`E2E verdict is "${e2e.verdict}", expected "PASS"`);
  if (PROJECT_E2E_TYPE_BY_VERDICT[e2e.verdict] !== e2eEnvelope.type) {
    errors.push(`E2E envelope type "${e2eEnvelope.type}" does not match payload verdict "${e2e.verdict}"`);
  }
  if (e2e.project_id !== manifest.project_id) {
    errors.push(`E2E project_id "${e2e.project_id}" != Manifest "${manifest.project_id}"`);
  }
  if (e2e.manifest_digest !== manifestDigest) {
    errors.push(`E2E manifest_digest "${e2e.manifest_digest}" != computed "${manifestDigest}"`);
  }
  if (e2e.expected_snapshot !== manifest.expected_snapshot) {
    errors.push(`E2E expected_snapshot "${e2e.expected_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
  }
  if (e2e.executed_snapshot !== manifest.expected_snapshot) {
    errors.push(`E2E executed_snapshot "${e2e.executed_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
  }
  const nonSkippedSteps = e2e.steps.filter((s) => !s.skipped);
  if (nonSkippedSteps.length === 0) errors.push('E2E has zero non-skipped steps');

  // ── 3. Reviewer result ──
  if (!fs.existsSync(input.reviewerResultPath)) {
    return { success: false, errors: [`Reviewer result not found: ${input.reviewerResultPath}`] };
  }
  const reviewerRaw = readJsonFile(input.reviewerResultPath);
  if (reviewerRaw === null) {
    return { success: false, errors: [`Invalid Project Reviewer result: cannot parse ${input.reviewerResultPath}`] };
  }
  let reviewerResult: ProjectReviewResult;
  try {
    reviewerResult = parseProjectReviewResult(reviewerRaw);
  } catch (err) {
    return {
      success: false,
      errors: [`Invalid Project Reviewer result: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (reviewerResult.verdict !== 'PROJECT_ACCEPTED') {
    errors.push(`Reviewer verdict is "${reviewerResult.verdict}", expected "PROJECT_ACCEPTED"`);
  }
  if (reviewerResult.reviewed_snapshot !== manifest.expected_snapshot) {
    errors.push(`Reviewer reviewed_snapshot "${reviewerResult.reviewed_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
  }
  if (reviewerResult.project_manifest.digest !== manifestDigest) {
    errors.push(`Reviewer project_manifest.digest "${reviewerResult.project_manifest.digest}" != computed manifest digest "${manifestDigest}"`);
  }

  if (!fs.existsSync(reviewerResult.project_e2e_receipt.path)) {
    errors.push(`Reviewer e2e receipt path not found: ${reviewerResult.project_e2e_receipt.path}`);
  } else {
    const reviewerE2eFileDigest = fileDigest16(reviewerResult.project_e2e_receipt.path);
    if (reviewerE2eFileDigest !== reviewerResult.project_e2e_receipt.digest) {
      errors.push(`Reviewer e2e receipt file digest "${reviewerE2eFileDigest}" != declared "${reviewerResult.project_e2e_receipt.digest}"`);
    }
    if (reviewerE2eFileDigest !== e2eFileDigest) {
      errors.push(`Reviewer e2e receipt file digest "${reviewerE2eFileDigest}" != actual E2E file digest "${e2eFileDigest}"`);
    }
  }

  // ── 4. Stage evidence triple-binding (single authoritative manifest path) ──
  const stageReceiptResults: ProjectReviewReceipt['stage_receipts'] = [];
  if (manifest.stage_receipts.length === 0) {
    errors.push('Manifest has zero stage_receipts entries');
  }

  for (const ms of manifest.stage_receipts) {
    const sid = ms.stage_id;

    // a. Stage manifest: exists + kernel-validated + canonical digest bound.
    let canonicalStageManifestDigest = '';
    if (!fs.existsSync(ms.stage_manifest.path)) {
      errors.push(`Stage manifest file not found for ${sid}: ${ms.stage_manifest.path}`);
    } else {
      const stageManifestRaw = readJsonFile(ms.stage_manifest.path);
      if (stageManifestRaw === null) {
        errors.push(`Stage manifest for ${sid}: cannot parse ${ms.stage_manifest.path}`);
      } else {
        try {
          validateManifest(stageManifestRaw);
          canonicalStageManifestDigest = computeCanonicalJsonDigest(stageManifestRaw);
          if (ms.stage_manifest.digest !== canonicalStageManifestDigest) {
            errors.push(`Stage manifest for ${sid}: declared digest "${ms.stage_manifest.digest}" != canonical "${canonicalStageManifestDigest}"`);
          }
        } catch (err) {
          errors.push(`Stage manifest for ${sid}: kernel validation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // b. Stage review receipt.
    if (!fs.existsSync(ms.review_receipt.path)) {
      errors.push(`Review receipt not found for stage ${sid}: ${ms.review_receipt.path}`);
      continue;
    }
    const reviewRaw = readJsonFile(ms.review_receipt.path);
    if (reviewRaw === null) {
      errors.push(`Invalid Stage Review for ${sid}: cannot parse ${ms.review_receipt.path}`);
      continue;
    }
    let review: StageReviewReceipt;
    try {
      review = parseStageReviewReceipt(reviewRaw);
    } catch (err) {
      errors.push(`Invalid Stage Review for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // c. Stage gate receipt.
    if (!fs.existsSync(ms.gate_receipt.path)) {
      errors.push(`Gate receipt not found for stage ${sid}: ${ms.gate_receipt.path}`);
      continue;
    }
    const gateRaw = readJsonFile(ms.gate_receipt.path);
    if (gateRaw === null) {
      errors.push(`Invalid Stage Gate for ${sid}: cannot parse ${ms.gate_receipt.path}`);
      continue;
    }
    let gate: StageGateReceipt;
    try {
      gate = parseStageGateReceipt(gateRaw);
    } catch (err) {
      errors.push(`Invalid Stage Gate for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // d. Cross-validation.
    if (review.stage_id !== sid) errors.push(`Review stage_id "${review.stage_id}" != manifest entry "${sid}"`);
    if (gate.stage_id !== sid) errors.push(`Gate stage_id "${gate.stage_id}" != manifest entry "${sid}"`);
    if (review.stage_id !== gate.stage_id) errors.push(`Review stage "${review.stage_id}" != Gate stage "${gate.stage_id}"`);
    if (review.verdict !== 'ACCEPTED') errors.push(`Review for ${sid} verdict is "${review.verdict}", expected "ACCEPTED"`);
    if (gate.verdict !== 'PASS') errors.push(`Gate for ${sid} verdict is "${gate.verdict}", expected "PASS"`);
    if (review.snapshot !== gate.snapshot) {
      errors.push(`Review snapshot "${review.snapshot}" != Gate snapshot "${gate.snapshot}" for ${sid}`);
    }

    // e. Canonical digest binding: review.manifest_digest / gate.manifest_digest.
    if (canonicalStageManifestDigest && review.manifest_digest !== canonicalStageManifestDigest) {
      errors.push(`Review manifest_digest for ${sid}: "${review.manifest_digest}" != canonical "${canonicalStageManifestDigest}"`);
    }
    if (canonicalStageManifestDigest && gate.manifest_digest !== canonicalStageManifestDigest) {
      errors.push(`Gate manifest_digest for ${sid}: "${gate.manifest_digest}" != canonical "${canonicalStageManifestDigest}"`);
    }

    // f. Triple-binding: review.stage_gate_receipt file digest === declared
    //    digest === manifest gate_receipt.digest.
    if (!fs.existsSync(review.stage_gate_receipt.path)) {
      errors.push(`Review's stage_gate_receipt path not found for ${sid}: ${review.stage_gate_receipt.path}`);
    } else {
      const reviewGateFileDigest = fileDigest16(review.stage_gate_receipt.path);
      if (reviewGateFileDigest !== review.stage_gate_receipt.digest) {
        errors.push(`Review for ${sid}: gate file digest "${reviewGateFileDigest}" != review declared "${review.stage_gate_receipt.digest}"`);
      }
      if (reviewGateFileDigest !== ms.gate_receipt.digest) {
        errors.push(`Review for ${sid}: gate file digest "${reviewGateFileDigest}" != manifest gate_receipt.digest "${ms.gate_receipt.digest}" (triple binding)`);
      }
    }

    // g. Review/gate file digests vs manifest declared digests.
    const reviewFileDigest = fileDigest16(ms.review_receipt.path);
    if (reviewFileDigest !== ms.review_receipt.digest) {
      errors.push(`Review file for ${sid}: actual digest "${reviewFileDigest}" != declared "${ms.review_receipt.digest}"`);
    }
    const gateFileDigest = fileDigest16(ms.gate_receipt.path);
    if (gateFileDigest !== ms.gate_receipt.digest) {
      errors.push(`Gate file for ${sid}: actual digest "${gateFileDigest}" != declared "${ms.gate_receipt.digest}"`);
    }

    stageReceiptResults.push({
      stage_id: sid,
      stage_manifest: { path: path.resolve(ms.stage_manifest.path), digest: canonicalStageManifestDigest },
      review: { path: path.resolve(ms.review_receipt.path), digest: reviewFileDigest },
      gate: { path: path.resolve(ms.gate_receipt.path), digest: gateFileDigest },
      snapshot: review.snapshot,
    });
  }

  // ── 5. Criteria one-to-one coverage ──
  if (manifest.acceptance_criteria.length !== reviewerResult.criteria_results.length) {
    errors.push(
      `Criteria count mismatch: Manifest has ${manifest.acceptance_criteria.length}, Reviewer has ${reviewerResult.criteria_results.length}`,
    );
  }
  const manifestCriteria = new Set(manifest.acceptance_criteria.map((c) => c.trim()));
  const resultCriteria = new Set(reviewerResult.criteria_results.map((c) => c.criteria.trim()));
  for (const mc of manifestCriteria) {
    if (!resultCriteria.has(mc)) errors.push(`Missing criteria result for: "${mc}"`);
  }
  for (const rc of resultCriteria) {
    if (!manifestCriteria.has(rc)) errors.push(`Extra criteria result not in Manifest: "${rc}"`);
  }
  if (!reviewerResult.criteria_results.every((c) => c.passed)) {
    errors.push('Not all criteria results are passed');
  }

  // ── 6. Reviewer-referenced manifest path file digest ──
  if (fs.existsSync(reviewerResult.project_manifest.path)) {
    const reviewerManifestFileDigest = fileDigest16(reviewerResult.project_manifest.path);
    if (reviewerManifestFileDigest !== manifestFileDigest) {
      errors.push(`Reviewer manifest path file digest "${reviewerManifestFileDigest}" != actual manifest digest "${manifestFileDigest}"`);
    }
  } else {
    errors.push(`Reviewer manifest path not found: ${reviewerResult.project_manifest.path}`);
  }

  // ── 7. Fail if any errors ──
  if (errors.length > 0) {
    return { success: false, errors };
  }

  // ── 8. Write PROJECT_REVIEW_PASS via kernel writeReceipt (chained to the
  //        E2E gate receipt envelope digest) ──
  const reviewReceipt: ProjectReviewReceipt = {
    project_id: manifest.project_id,
    verdict: 'PROJECT_ACCEPTED',
    snapshot: manifest.expected_snapshot,
    reviewer: reviewerResult.reviewer,
    findings: reviewerResult.findings ?? [],
    accepted_deviations: reviewerResult.accepted_deviations ?? [],
    project_manifest: { path: path.resolve(input.manifestPath), digest: manifestDigest },
    project_e2e_receipt: { path: path.resolve(input.e2eReceiptPath), digest: e2eFileDigest },
    reviewed_at: reviewerResult.reviewed_at,
    stage_receipts: stageReceiptResults,
    criteria_results: reviewerResult.criteria_results,
  };
  const envelope = {
    version: 1 as const,
    type: 'PROJECT_REVIEW_PASS' as const,
    stage_id: manifest.project_id,
    timestamp: reviewerResult.reviewed_at,
    previous_digest: e2eEnvelope.digest,
    payload: reviewReceipt,
  };
  try {
    const receiptDir = path.resolve(input.outputDir);
    const written = writeReceipt(envelope, { receiptDir, tempDir: receiptDir });
    return {
      success: true,
      receiptPath: written.path,
      receiptDigest: written.digest,
      errors: [],
    };
  } catch (err) {
    return {
      success: false,
      errors: [`Cannot write Project Review Receipt: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
