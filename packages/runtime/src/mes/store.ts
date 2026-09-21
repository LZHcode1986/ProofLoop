/**
 * @proofloop/runtime — atomic MES snapshot store (S01-A-T02).
 *
 * Persists the validated MES fact envelope set as ONE canonical snapshot
 * under `.proofloop/mes/snapshot.json` using the existing root/path/TOCTOU
 * primitives:
 *
 *   - write: every fact is validated (validateMesFactEnvelope) BEFORE any
 *     file is touched; the snapshot is written to a unique temp file in the
 *     same directory and atomically renamed over the previous snapshot — an
 *     interrupted or failed write never leaves a half-written snapshot, and
 *     a validation failure never replaces the last valid snapshot; one write
 *     never carries two facts for the same fact_id (S02-C-T02): identical
 *     payload replays collapse idempotently, while a DIFFERENT payload under
 *     a duplicate fact_id in the same submission fails closed (contracts §7
 *     RESULT_INVALID) before any file is touched;
 *   - write also enforces the S02 planning durable-fact relational binding
 *     and replay integrity (S02-SR-F001): a submitted `plan_acceptance`
 *     closes only when its `verification_result_ref` resolves to a durable
 *     PLAN_READY `planning_verification_result` in the submitted set or the
 *     current valid snapshot (kind / candidate stage / PLAN_READY verdict /
 *     exact result_ref / agreed plan ref / digest / git_basis.head); a
 *     planning fact_id already in the valid snapshot with a DIFFERENT
 *     canonical payload fails closed no-write across submissions, while
 *     identical replay is deduplicated and byte-stable, and existing
 *     planning facts are preserved (immutable once persisted) — S01
 *     seed-owned facts keep their bootstrap-repair rewrite semantics;
 *   - write also enforces the S04-B terminal / Review→Finding relational
 *     write-throughs (contracts.md §2.1.1 / §5.1, acceptance E2E-06 /
 *     STATIC-29): a submitted `project_ready` closes only when its closed
 *     planned Stage-ID set EXACTLY equals the durable accepted-stage
 *     support set in the SAME persisted result set (submitted ∪ retained,
 *     machine-closed predicate; per-fact git_basis values never compared —
 *     each support fact keeps its own verified basis); a persisted
 *     `project_ready` is immutable like the planning facts (identical
 *     replay byte-stable, conflicting payload no-write); unresubmitted
 *     `project_ready` / accepted-stage support / `finding` /
 *     `finding_disposition` durable facts are retained across snapshot
 *     replacement (partial writes never drop terminal or Review→Finding
 *     relation support; restart rebuilds the same closures); and every
 *     submitted `finding_disposition.finding_ref` resolves by exact fact_id
 *     to a UNIQUE durable `finding` fact in the same persisted result set
 *     (missing / ambiguous / non-finding resolution no-write). MES never
 *     reads the Project Stage Map — the planned set is expressed through
 *     the fact payload by Brain;
 *   - write also retains cross-Stage task facts: a task fact that is exact
 *     canonical byte-equivalent to an already-durable fact in the current
 *     valid snapshot is NOT re-validated against the current submission's
 *     accepted_plan_task_graph — it was graph-bound at its own durable write
 *     against its own Stage's accepted Plan (mixed-stage replace-all
 *     submissions carry durable historical facts + the current Stage's new
 *     facts under the current graph). A NEW or CHANGED task fact keeps the
 *     full fail-closed graph binding: missing/wrong graph, phantom task id,
 *     dependency edge mismatch and cross-stage/cross-slice scope mismatch
 *     all no-write before any file op;
 *   - read: `readRootBoundFile` enforces the root-bound no-follow boundary
 *     (rejects symlink final components, root escape, invalid UTF-8 and
 *     TOCTOU changes), then the JSON container and EVERY fact are validated
 *     fail-closed — corrupted / unknown / malformed content never yields
 *     partial facts;
 *   - there is NO Agent-facing direct-write channel: only validated fact
 *     sets can be persisted, and only Brain/Host consumers call the store.
 *   - (S05-B-T01 / PO-S05-B-04) ANY ordinary write (every delta except the
 *     exact-source disaster recovery baseline transaction) over an
 *     unreadable / corrupt / path-invalid current snapshot is no-write: the
 *     durable retained facts are invisible to the retention merge when the
 *     read fails, so a rewrite would treat the unreadable store as EMPTY and
 *     silently drop them (contracts §7 RESULT_INVALID). A submitted disaster
 *     recovery baseline (whose source check is raw-content based) is the only
 *     lawful seam that rewrites an unrecoverable snapshot.
 *
 * Snapshot container shape (canonical JSON, schema_versioned):
 *   { "schema_version": 2, "facts": [<MesFactEnvelope>, ...] }
 *
 * No second state machine / Receipt / Manifest / Gate semantics (STATIC-14);
 * the snapshot is the durable MES facts carrier only.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalStringify } from '../cli/proofloop-common';
import {
  canonicalPathWithinRoot,
  readRootBoundFile,
  type PathReadError,
} from '../path-guard';
import { MES_SCHEMA_VERSION } from './types';
import { validateMesFactEnvelope, SchemaValidationError } from './validate';
import { verifyPlanAcceptanceSupport, verifyAcceptedStageReviewResultSupport, validateTaskFactGraphBinding, taskFactScopeConsistencyError, verifyPlanAcceptanceSuccessionGraphError, resolvePlanAcceptanceGenerationTips, isCycleBearingPlanAcceptanceGeneration } from './binding';
import { isDurableAcceptedStageSupport, verifyProjectReadySupportError, resolveFindingDispositionRefError, verifyProjectReadySuccessionGraphError } from './terminal';
import type { MesFactEnvelope, MesGitBasis } from './types';

export type { MesFactEnvelope };

/** Root-relative snapshot location inside the trust root. */
export const MES_SNAPSHOT_REL = path.join('.proofloop', 'mes', 'snapshot.json');

/** Closed store failure codes (fail closed, never partial). */
export type MesSnapshotStoreErrorCode =
  | 'escape'
  | 'invalid-fact'
  | 'corrupt-snapshot'
  | 'unreadable'
  | 'write-failed';

/** Bounded store error raised on any fail-closed condition. */
export class MesSnapshotStoreError extends Error {
  public readonly code: MesSnapshotStoreErrorCode;

  constructor(code: MesSnapshotStoreErrorCode, message: string) {
    super(message);
    this.name = 'MesSnapshotStoreError';
    this.code = code;
  }
}

function storeFail(code: MesSnapshotStoreErrorCode, message: string): never {
  throw new MesSnapshotStoreError(code, message);
}


function sha256Utf8(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the first write of a disaster recovery baseline against the observed source. */
function recoveryBaselineSourceError(
  root: string,
  fact: MesFactEnvelope,
  currentSnapshotContent: string,
 ): string | undefined {
  const sourceDigest = sha256Utf8(currentSnapshotContent);
  if (fact.source_snapshot_sha256 !== sourceDigest) {
    return `recovery_baseline source_snapshot_sha256 does not match the currently observed snapshot (${sourceDigest})`;
  }
  let source: unknown;
  try {
    source = JSON.parse(currentSnapshotContent);
  } catch {
    return 'recovery_baseline source snapshot is not valid JSON';
  }
  if (!isRecord(source) || !Array.isArray(source.facts) || source.facts.length !== fact.source_fact_count) {
    return 'recovery_baseline source_fact_count does not match the currently observed snapshot';
  }
  let forensicContent: string;
  let auditContent: string;
  try {
    forensicContent = readRootBoundFile(root, fact.forensic_ref!).content;
    auditContent = readRootBoundFile(root, fact.audit_ref!).content;
  } catch (error) {
    return `recovery_baseline forensic/audit ref is not re-readable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (sha256Utf8(auditContent) !== fact.audit_sha256) {
    return 'recovery_baseline audit_sha256 does not match audit_ref content';
  }
  try {
    const incident = JSON.parse(forensicContent) as unknown;
    const audit = JSON.parse(auditContent) as unknown;
    if (!isRecord(incident)) {
      return 'recovery_baseline forensic_ref is not a JSON object';
    }
    if (!isRecord(audit)) {
      return 'recovery_baseline audit_ref is not a JSON object';
    }
    // (S06-R-F-T01) Current Authority-approved S06 binding-mismatch incident
    // semantics: the current incident (binding-mismatch / source-incident
    // relation / read-only audit) must be validated against its OWN canonical
    // layout — never forced into the historical S05 field layout — while
    // every fail-closed criterion (exact source digest/count, root-bound
    // forensic/audit binding, unrecoverable-history semantics, complete
    // relation/currentness validation) stays enforced.
    if (incident.incident_type === 'mes_binding_mismatch_in_durable_facts') {
      const sourceFacts = Array.isArray(source.facts) ? (source.facts as unknown[]) : [];
      const currentError = recoveryBaselineCurrentIncidentError(root, fact, sourceDigest, incident, audit, sourceFacts);
      if (currentError !== undefined) return currentError;
    } else {
      // Historical S05 unrecoverable-preimage incident field layout (legacy
      // valid recovery-baseline regressions stay green).
      if (incident.status !== 'MES_RECOVERY_REQUIRED' || incident.preimage_recovery !== 'EXACT_178_FACT_PREIMAGE_UNRECOVERABLE') {
        return 'recovery_baseline forensic_ref is not the declared unrecoverable-preimage incident';
      }
      const sourceRecord = isRecord(incident.source_snapshot) ? incident.source_snapshot : undefined;
      if (!sourceRecord || sourceRecord.sha256 !== sourceDigest || sourceRecord.fact_count !== fact.source_fact_count) {
        return 'recovery_baseline forensic incident does not match the observed source snapshot';
      }
      const damage = isRecord(audit.damage_conclusion) ? audit.damage_conclusion : undefined;
      if (audit.audit_mode !== 'read_only' || audit.snapshot_sha256 !== sourceDigest || audit.fact_count !== fact.source_fact_count || damage?.exact_preimage_available !== false) {
        return 'recovery_baseline audit_ref is not a matching read-only unrecoverable audit';
      }
      // (SPV-S05-REC-001 F3) Ambiguous audit relation markers fail closed:
      // the read-only relational audit must explicitly report its duplicate /
      // relation-resolution evidence, and that evidence must be unambiguous
      // (no duplicate fact ids; every finding-disposition resolves to exactly
      // one finding; every acceptance resolves to exactly one PVR; every
      // accepted-stage result resolves to exactly one support fact). An audit
      // reporting duplicate or ambiguous relation evidence cannot prove
      // baseline readiness and produces no-write (contracts §2.2.4a /
      // acceptance E2E-24).
      const markerError = recoveryAuditRelationMarkerError(audit);
      if (markerError !== undefined) return markerError;
    }
  } catch {
    return 'recovery_baseline forensic/audit refs must contain valid JSON artifacts';
  }
  return undefined;
}

/**
 * (SPV-S05-REC-001 F3) Fail-closed audit relation-marker check: the
 * read-only relational audit artifact must report its duplicate / relation-
 * resolution evidence unambiguously. A non-empty `duplicate_fact_ids` (duplicate
 * fact evidence), a `finding_disposition_relations` entry without a unique
 * `resolves_fact_id` (ambiguous Review→Finding mapping), a
 * `plan_acceptance_relations` entry without a `pvr_fact_id` (ambiguous
 * acceptance support) or a `project_ready_closure.stage_result_refs` entry
 * whose `resolves_to` is not exactly one support fact (ambiguous accepted-stage
 * support) is a marker that the retained relations are NOT baseline-ready and
 * must abort the recovery write no-write.
 */
function recoveryAuditRelationMarkerError(audit: Record<string, unknown>): string | undefined {
  const duplicates = audit.duplicate_fact_ids;
  if (!Array.isArray(duplicates) || duplicates.length > 0) {
    return 'recovery_baseline audit must report duplicate_fact_ids as an empty array (duplicate relation evidence is ambiguous, no-write)';
  }
  const dispositions = audit.finding_disposition_relations;
  if (!Array.isArray(dispositions)) {
    return 'recovery_baseline audit must report finding_disposition_relations as an array (missing relation evidence is ambiguous, no-write)';
  }
  for (let i = 0; i < dispositions.length; i++) {
    const entry = dispositions[i];
    if (!isRecord(entry) || typeof entry.resolves_fact_id !== 'string' || entry.resolves_fact_id.length === 0) {
      return `recovery_baseline audit finding_disposition_relations[${i}] must carry a unique non-empty resolves_fact_id (ambiguous relation evidence, no-write)`;
    }
  }
  const acceptances = audit.plan_acceptance_relations;
  if (!Array.isArray(acceptances)) {
    return 'recovery_baseline audit must report plan_acceptance_relations as an array (missing relation evidence is ambiguous, no-write)';
  }
  for (let i = 0; i < acceptances.length; i++) {
    const entry = acceptances[i];
    if (!isRecord(entry) || typeof entry.pvr_fact_id !== 'string' || entry.pvr_fact_id.length === 0) {
      return `recovery_baseline audit plan_acceptance_relations[${i}] must carry a unique non-empty pvr_fact_id (ambiguous relation evidence, no-write)`;
    }
  }
  const closure = isRecord(audit.project_ready_closure) ? audit.project_ready_closure : undefined;
  if (closure === undefined || !Array.isArray(closure.stage_result_refs)) {
    return 'recovery_baseline audit must report project_ready_closure.stage_result_refs as an array (missing relation evidence is ambiguous, no-write)';
  }
  for (let i = 0; i < closure.stage_result_refs.length; i++) {
    const entry = closure.stage_result_refs[i];
    if (!isRecord(entry) || !Array.isArray(entry.resolves_to) || entry.resolves_to.length !== 1) {
      return `recovery_baseline audit project_ready_closure.stage_result_refs[${i}].resolves_to must resolve to exactly one support fact (ambiguous relation evidence, no-write)`;
    }
  }
  return undefined;
}

/**
 * (S06-R-F-T01) Current Authority-approved S06 binding-mismatch incident
 * validation (fail-closed): the current incident declares its own
 * incident_type / source-incident relation / source snapshot + forensic copy /
 * accepted-Plan relation / unrecoverable-history semantics and a read-only
 * relational audit that reports exact source digest/count, forensic copy
 * byte equality, misbound relation evidence and routing safety as explicit
 * checks. It must NOT be required to masquerade as the historical S05 field
 * layout (status/preimage_recovery/audit_mode/damage_conclusion markers);
 * every fail-closed criterion stays enforced (contracts §2.2.4a / acceptance
 * E2E-24/E2E-25/E2E-26, ADR-021/022).
 */
function recoveryBaselineCurrentIncidentError(
  root: string,
  fact: MesFactEnvelope,
  sourceDigest: string,
  incident: Record<string, unknown>,
  audit: Record<string, unknown>,
  sourceFacts: unknown[],
): string | undefined {
  // Source-incident relation: the current binding-mismatch incident must
  // declare a distinct, root-bound, re-readable source incident (the
  // fact-gap capture). Missing / self-referential / unreadable relation
  // fails closed (stop condition: wrong or missing source-incident relation).
  const sourceIncidentRef = incident.source_incident_ref;
  if (typeof sourceIncidentRef !== 'string' || sourceIncidentRef.length === 0) {
    return 'recovery_baseline current incident must declare a source_incident_ref (missing source-incident relation, no-write)';
  }
  if (sourceIncidentRef === fact.forensic_ref) {
    return 'recovery_baseline current incident source_incident_ref must not self-reference the forensic incident (wrong source-incident relation, no-write)';
  }
  let sourceIncidentContent: string;
  try {
    sourceIncidentContent = readRootBoundFile(root, sourceIncidentRef).content;
  } catch (error) {
    return `recovery_baseline source-incident ref is not re-readable: ${error instanceof Error ? error.message : String(error)}`;
  }
  let sourceIncident: unknown;
  try {
    sourceIncident = JSON.parse(sourceIncidentContent);
  } catch {
    return 'recovery_baseline source-incident ref is not valid JSON (wrong source-incident relation, no-write)';
  }
  if (!isRecord(sourceIncident) || sourceIncident.status !== 'MES_RECOVERY_REQUIRED' || typeof sourceIncident.incident_id !== 'string' || sourceIncident.incident_id.length === 0) {
    return 'recovery_baseline source-incident ref is not a recovery-required incident artifact (wrong source-incident relation, no-write)';
  }

  // (S06-R-G-T01) Canonical source-incident identity binding closure: the
  // authoritative source-incident identity is resolved from the observed
  // source's EXISTING durable recovery_baseline facts (fact_id/recovery_id
  // embedded incident identity), never from the candidate incident's
  // self-declared fields. The candidate source_incident_ref is only a
  // root-bound candidate pointer whose resolution must EXACTLY match the
  // canonical durable recovery_baseline fact; missing / ambiguous /
  // disagreeing / duplicate evidence fails closed no-write.
  const canonicalIdentityError = sourceIncidentIdentityBindingError(root, sourceIncident, sourceFacts);
  if (canonicalIdentityError !== undefined) return canonicalIdentityError;
  // Exact source snapshot + forensic copy binding against the CURRENT
  // observed snapshot (source digest/count must match; the forensic copy must
  // be byte-equal to the source).
  const sourceRecord = isRecord(incident.source_snapshot) ? incident.source_snapshot : undefined;
  if (!sourceRecord || sourceRecord.sha256 !== sourceDigest || sourceRecord.fact_count !== fact.source_fact_count) {
    return 'recovery_baseline current incident source snapshot does not match the observed source (source digest/count mismatch, no-write)';
  }
  const copyRecord = isRecord(incident.forensic_copy) ? incident.forensic_copy : undefined;
  if (!copyRecord || copyRecord.sha256 !== sourceDigest || copyRecord.fact_count !== fact.source_fact_count || copyRecord.byte_equal_to_source !== true) {
    return 'recovery_baseline current incident forensic copy is not byte-equal to the observed source (no-write)';
  }
  // Unrecoverable-history semantics: the current incident must not attempt
  // reconstruction or history rewrite (ADR-021/022).
  const preimage = isRecord(incident.preimage_and_reconstruction) ? incident.preimage_and_reconstruction : undefined;
  if (!preimage || preimage.missing_fact_reconstruction_attempted !== false || preimage.historical_facts_rewritten !== false) {
    return 'recovery_baseline current incident must declare no reconstruction / no history rewrite (unrecoverable-history semantics, no-write)';
  }
  // Accepted-Plan relation support (plan-acceptance evidence in the incident).
  const planRelation = isRecord(incident.accepted_plan_relation) ? incident.accepted_plan_relation : undefined;
  if (!planRelation || typeof planRelation.plan_ref !== 'string' || planRelation.plan_ref.length === 0 || typeof planRelation.planning_verification_result_ref !== 'string' || planRelation.planning_verification_result_ref.length === 0) {
    return 'recovery_baseline current incident must declare an accepted_plan_relation (missing plan-acceptance support, no-write)';
  }
  // Read-only audit binding: mode + exact source digest/count + forensic copy
  // byte equality + unrecoverable-history semantics.
  if (audit.mode !== 'read_only' || audit.source_snapshot_sha256 !== sourceDigest || audit.source_fact_count !== fact.source_fact_count) {
    return 'recovery_baseline audit_ref is not a matching read-only audit for the observed source (no-write)';
  }
  if (audit.forensic_copy_sha256 !== sourceDigest || audit.forensic_copy_byte_equal_to_source !== true) {
    return 'recovery_baseline audit forensic copy binding does not match the observed source (no-write)';
  }
  if (audit.no_reconstruction !== true || audit.no_history_rewrite !== true) {
    return 'recovery_baseline audit must declare no_reconstruction/no_history_rewrite (unrecoverable-history semantics, no-write)';
  }
  // Complete relation/currentness validation from current canonical facts:
  // the read-only audit must report its relation evidence as an explicit
  // checks[] set (equivalent-or-stronger to the historical marker arrays) —
  // missing current audit marker arrays are NEVER treated as PASS.
  return recoveryCurrentIncidentAuditError(incident, audit, sourceFacts);
}

/**
 * (S06-R-F-T01) Fail-closed relation/currentness evidence for the current
 * S06 audit artifact: the read-only relational audit must report its
 * duplicate/relation-resolution evidence as an explicit `checks[]` set with
 * definite results (missing/ambiguous evidence is never PASS), a non-empty
 * unique `misbound_fact_ids` set, and a closed `canonical_relation`
 * (plan-acceptance support). Each negative fails closed no-write.
 */
function recoveryCurrentIncidentAuditError(
  incident: Record<string, unknown>,
  audit: Record<string, unknown>,
  sourceFacts: unknown[],
): string | undefined {
  const checks = audit.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    return 'recovery_baseline current audit must report checks[] (missing relation/currentness evidence is ambiguous, no-write)';
  }
  const results = new Map<string, string>();
  for (let i = 0; i < checks.length; i++) {
    const entry = checks[i];
    if (!isRecord(entry) || typeof entry.check !== 'string' || entry.check.length === 0 || typeof entry.result !== 'string' || entry.result.length === 0) {
      return `recovery_baseline current audit checks[${i}] must carry a definite check/result pair (ambiguous relation evidence, no-write)`;
    }
    if (results.has(entry.check)) {
      return `recovery_baseline current audit checks[] must not repeat check ${JSON.stringify(entry.check)} (ambiguous relation evidence, no-write)`;
    }
    results.set(entry.check, entry.result);
  }
  // Required closed checks with definite results.
  const required = new Map<string, string>([
    ['exact source digest/count/schema', 'PASS'],
    ['forensic copy byte equality', 'PASS'],
    ['misbound facts retained in source', 'PASS'],
    ['accepted Plan binding relation', 'PASS'],
    ['misbound relation validity', 'INVALID_NON_AUTHORIZING'],
    ['public status routing safety', 'OBSERVATION_ONLY'],
    ['MES write quarantine', 'PASS'],
  ]);
  for (const [name, expected] of required) {
    if (results.get(name) !== expected) {
      return `recovery_baseline current audit checks[] must report ${JSON.stringify(name)} = ${JSON.stringify(expected)} (missing/ambiguous relation evidence, no-write)`;
    }
  }
  // Ref-bearing checks must carry their refs (unambiguous resolution).
  const checkEntries = new Map<string, Record<string, unknown>>();
  for (const entry of checks as Record<string, unknown>[]) {
    if (isRecord(entry) && typeof entry.check === 'string') checkEntries.set(entry.check, entry);
  }
  const planBinding = checkEntries.get('accepted Plan binding relation');
  if (!planBinding || typeof planBinding.canonical_ref !== 'string' || planBinding.canonical_ref.length === 0) {
    return 'recovery_baseline current audit accepted Plan binding relation must carry a canonical_ref (missing plan-acceptance support, no-write)';
  }
  const misboundValidity = checkEntries.get('misbound relation validity');
  if (!misboundValidity || typeof misboundValidity.submitted_ref !== 'string' || misboundValidity.submitted_ref.length === 0 || typeof misboundValidity.canonical_ref !== 'string' || misboundValidity.canonical_ref.length === 0) {
    return 'recovery_baseline current audit misbound relation validity must carry submitted_ref/canonical_ref (ambiguous finding-disposition relation, no-write)';
  }
  const routingSafety = checkEntries.get('public status routing safety');
  if (!routingSafety || routingSafety.dispatch_authorized !== false) {
    return 'recovery_baseline current audit public status routing safety must not authorize dispatch (invalid project-ready / accepted-stage closure, no-write)';
  }
  // Misbound fact ids: non-empty, unique (duplicate fact IDs fail closed),
  // and consistent with the incident's misbound facts (cross-relation).
  const misboundIds = audit.misbound_fact_ids;
  if (!Array.isArray(misboundIds) || misboundIds.length === 0) {
    return 'recovery_baseline current audit must report misbound_fact_ids (missing relation evidence is ambiguous, no-write)';
  }
  const seen = new Set<string>();
  for (let i = 0; i < misboundIds.length; i++) {
    const id = misboundIds[i];
    if (typeof id !== 'string' || id.length === 0) {
      return `recovery_baseline current audit misbound_fact_ids[${i}] must be a non-empty fact id (ambiguous relation evidence, no-write)`;
    }
    if (seen.has(id)) {
      return `recovery_baseline current audit misbound_fact_ids reports duplicate fact id ${JSON.stringify(id)} (duplicate relation evidence, no-write)`;
    }
    seen.add(id);
  }
  // Cross-relation closure: every audit misbound id must resolve to an
  // incident misbound fact (no dangling/ambiguous/cross-relation evidence).
  const incidentMisbound = incident.misbound_facts;
  if (!Array.isArray(incidentMisbound) || incidentMisbound.length === 0) {
    return 'recovery_baseline current incident must report misbound_facts (missing relation evidence is ambiguous, no-write)';
  }
  const incidentIds = new Set<string>();
  for (let i = 0; i < incidentMisbound.length; i++) {
    const factRec = incidentMisbound[i];
    if (!isRecord(factRec) || typeof factRec.fact_id !== 'string' || factRec.fact_id.length === 0) {
      return `recovery_baseline current incident misbound_facts[${i}] must carry a non-empty fact_id (ambiguous relation evidence, no-write)`;
    }
    if (incidentIds.has(factRec.fact_id)) {
      return `recovery_baseline current incident misbound_facts reports duplicate fact id ${JSON.stringify(factRec.fact_id)} (duplicate relation evidence, no-write)`;
    }
    incidentIds.add(factRec.fact_id);
  }
  for (const id of seen) {
    if (!incidentIds.has(id)) {
      return `recovery_baseline current audit misbound_fact_id ${JSON.stringify(id)} does not resolve to an incident misbound fact (dangling cross-relation evidence, no-write)`;
    }
  }
  // (S06-R-F-T01 relation-set exactness) Bidirectional semantic equality of
  // the misbound relation set: audit misbound_fact_ids and incident
  // misbound_facts[].fact_id must be EXACTLY the same set — an id absent
  // from either side, an extra id on either side, or a different count is
  // incomplete/non-identical relation evidence and fails closed no-write
  // (contracts §2.2.4a / E2E-24; a strict subset is never a complete audit).
  for (const id of incidentIds) {
    if (!seen.has(id)) {
      return `recovery_baseline incident misbound fact ${JSON.stringify(id)} is absent from audit misbound_fact_ids (incomplete relation evidence; strict subset is never a complete audit, no-write)`;
    }
  }
  if (seen.size !== incidentIds.size) {
    return 'recovery_baseline audit misbound_fact_ids count must exactly equal incident misbound_facts count (non-identical relation set, no-write)';
  }
  // Every fact of the exact complete misbound set must resolve in the exact
  // frozen source snapshot — the relation set is grounded in the observed
  // durable source, not in free-floating marker text.
  const sourceFactIds = new Set<string>();
  const sourceFactsById = new Map<string, Record<string, unknown>>();
  for (const raw of sourceFacts) {
    if (!isRecord(raw) || typeof raw.fact_id !== 'string' || raw.fact_id.length === 0) continue;
    sourceFactIds.add(raw.fact_id);
    sourceFactsById.set(raw.fact_id, raw);
  }
  for (const id of incidentIds) {
    if (!sourceFactIds.has(id)) {
      return `recovery_baseline misbound relation fact ${JSON.stringify(id)} does not exist in the observed source snapshot (dangling relation evidence, no-write)`;
    }
  }
  // Closed canonical relation (plan-acceptance support evidence).
  const canonical = isRecord(audit.canonical_relation) ? audit.canonical_relation : undefined;
  if (!canonical || typeof canonical.plan_ref !== 'string' || canonical.plan_ref.length === 0 || typeof canonical.planning_verification_result_ref !== 'string' || canonical.planning_verification_result_ref.length === 0 || typeof canonical.plan_acceptance_fact_id !== 'string' || canonical.plan_acceptance_fact_id.length === 0 || typeof canonical.delivery_cycle_id !== 'string' || canonical.delivery_cycle_id.length === 0 || typeof canonical.plan_digest !== 'string' || canonical.plan_digest.length === 0) {
    return 'recovery_baseline current audit must report a closed canonical_relation (missing/ambiguous plan-acceptance support, no-write)';
  }
  // Relation exactness of accepted-Plan evidence: incident.accepted_plan_relation
  // and canonical_relation must agree on EVERY identity field — a
  // syntactically complete but disagreeing canonical relation must never
  // authorize recovery.
  const planRelation = isRecord(incident.accepted_plan_relation) ? incident.accepted_plan_relation : undefined;
  if (!planRelation) {
    return 'recovery_baseline current incident must report accepted_plan_relation (missing plan-acceptance support, no-write)';
  }
  const relationKeys = ['plan_ref', 'planning_verification_fact_id', 'planning_verification_result_ref', 'plan_acceptance_fact_id', 'delivery_cycle_id', 'plan_digest'] as const;
  for (const key of relationKeys) {
    if (canonical[key] !== planRelation[key]) {
      return `recovery_baseline canonical_relation.${key} disagrees with incident accepted_plan_relation (non-identical canonical relation, no-write)`;
    }
  }
  // The canonical relation must resolve to the canonical durable support in
  // the observed source: the referenced planning_verification_result fact
  // (exact fact_id + result_ref + plan binding) and the plan_acceptance fact
  // (exact fact_id + verification_result_ref + accepted plan binding) MUST
  // exist in the frozen snapshot and form the accepted-Plan support chain —
  // not inferred from marker text.
  const pvr = sourceFactsById.get(canonical.planning_verification_fact_id as string);
  if (!pvr || pvr.fact_kind !== 'planning_verification_result' || pvr.result_ref !== canonical.planning_verification_result_ref) {
    return 'recovery_baseline canonical planning_verification_fact_id does not resolve to the durable PLAN_READY PVR in the observed source (missing/ambiguous plan-acceptance support, no-write)';
  }
  const pvrBinding = isRecord(pvr.plan_binding) ? pvr.plan_binding : undefined;
  if (!pvrBinding || pvrBinding.delivery_cycle_id !== canonical.delivery_cycle_id || pvrBinding.plan_digest !== canonical.plan_digest || pvrBinding.candidate_plan_ref !== canonical.plan_ref) {
    return 'recovery_baseline canonical PVR plan_binding disagrees with canonical_relation (non-identical durable support, no-write)';
  }
  // (S06-R-F-T01 canonical-PVR-verdict) The resolved canonical PVR must carry
  // plan_binding.verdict EXACTLY PLAN_READY: only a PLAN_READY verification can
  // underpin the accepted-Plan relation (contracts §2.2.4a / acceptance E2E-24
  // / STATIC-13). A matching fact_kind/result_ref/binding with verdict FINDINGS,
  // BLOCKED, or any non-PLAN_READY value (or a missing verdict) fails closed
  // no-write — the canonical durable support must never be inferred from a
  // failed/blocked verification.
  if (pvrBinding.verdict !== 'PLAN_READY') {
    return `recovery_baseline canonical planning_verification_fact_id resolves to a PVR with verdict ${JSON.stringify(pvrBinding.verdict)} (must be exactly PLAN_READY; non-PLAN_READY canonical support fails closed, no-write)`;
  }
  const pa = sourceFactsById.get(canonical.plan_acceptance_fact_id as string);
  if (!pa || pa.fact_kind !== 'plan_acceptance') {
    return 'recovery_baseline canonical plan_acceptance_fact_id does not resolve to a durable plan_acceptance in the observed source (missing/ambiguous plan-acceptance support, no-write)';
  }
  const paBinding = isRecord(pa.plan_binding) ? pa.plan_binding : undefined;
  if (!paBinding || paBinding.verification_result_ref !== canonical.planning_verification_result_ref || paBinding.delivery_cycle_id !== canonical.delivery_cycle_id || paBinding.plan_digest !== canonical.plan_digest || paBinding.accepted_plan_ref !== canonical.plan_ref) {
    return 'recovery_baseline canonical plan_acceptance plan_binding does not resolve to the canonical PVR relation (non-identical durable support, no-write)';
  }
  return undefined;
}


/**
 * (S06-R-G-T01) Canonical source-incident identity binding closure:
 * the authoritative source-incident identity is resolved from the observed
 * source snapshot's EXISTING durable `recovery_baseline` facts (the
 * fact_id/recovery_id embedded incident identity), NEVER from the candidate
 * incident's self-declared fields. The candidate `source_incident_ref` is
 * only a root-bound candidate pointer: its resolution must EXACTLY match
 * exactly one canonical durable recovery_baseline fact, whose forensic_ref
 * identity and source_snapshot_sha256/source_fact_count are the binding
 * basis. Missing / ambiguous / disagreeing / duplicate evidence fails
 * closed no-write (contracts §2.1.3 / §2.2.4a / E2E-24/25, ADR-021/022).
 */
function sourceIncidentIdentityBindingError(
  root: string,
  sourceIncident: Record<string, unknown>,
  sourceFacts: unknown[],
): string | undefined {
  // 1) Candidate-declared source incident identity (the resolved candidate
  //    pointer's identity — authoritative only after exact canonical match).
  const candidateIdentity = sourceIncident.incident_id;
  if (typeof candidateIdentity !== 'string' || candidateIdentity.length === 0) {
    return 'recovery_baseline candidate source incident must carry a non-empty incident_id (missing source-incident identity, no-write)';
  }

  // 2) Resolve the authoritative source-incident identity from the observed
  //    source's EXISTING durable recovery_baseline facts: recovery_id is the
  //    embedded incident identity (fact_id === mes:fact:recovery_baseline:<id>).
  // 2a) Raw durable recovery_baseline identity well-formedness (contracts
  //    §2.2.4a / validate.ts read-only anchor): every durable recovery_baseline
  //    fact in the observed source must embed its OWN recovery_id in its
  //    fact_id (fact_id === mes:fact:recovery_baseline:<recovery_id>). A
  //    malformed raw pair — fact_id not equal to the canonical embedded form,
  //    or fact_id/recovery_id identifying DIFFERENT recovery identities —
  //    makes the durable identity evidence untrustworthy and fails closed
  //    no-write byte-stable (never accepted as canonical identity evidence).
  for (const raw of sourceFacts) {
    if (!isRecord(raw) || raw.fact_kind !== 'recovery_baseline') continue;
    if (
      typeof raw.fact_id !== 'string' ||
      typeof raw.recovery_id !== 'string' ||
      raw.recovery_id.length === 0 ||
      raw.fact_id !== `mes:fact:recovery_baseline:${raw.recovery_id}`
    ) {
      return `recovery_baseline observed source reports a malformed raw durable recovery_baseline fact_id/recovery_id identity (fact_id must equal mes:fact:recovery_baseline:<recovery_id>; mismatched canonical pair identifying different recovery identities is no-write)`;
    }
  }
  const matches: Array<Record<string, unknown>> = [];
  for (const raw of sourceFacts) {
    if (!isRecord(raw) || raw.fact_kind !== 'recovery_baseline') continue;
    if (raw.recovery_id === candidateIdentity) matches.push(raw);
  }
  if (matches.length === 0) {
    return `recovery_baseline candidate source-incident identity ${JSON.stringify(candidateIdentity)} is not recorded by any durable recovery_baseline fact in the observed source (missing canonical source-incident identity, no-write)`;
  }
  if (matches.length > 1) {
    return `recovery_baseline candidate source-incident identity ${JSON.stringify(candidateIdentity)} matches ${matches.length} durable recovery_baseline facts in the observed source (ambiguous canonical source-incident identity, no-write)`;
  }
  const canonical = matches[0];

  // 3) Canonical fact's forensic_ref must be re-readable and its incident
  //    identity must agree with the candidate source incident (same recovery
  //    epoch — path approximation never counts).
  const canonicalForensicRef = canonical.forensic_ref;
  if (typeof canonicalForensicRef !== 'string' || canonicalForensicRef.length === 0) {
    return 'recovery_baseline canonical recovery_baseline fact must declare a forensic_ref (missing canonical forensic identity, no-write)';
  }
  let canonicalForensicContent: string;
  try {
    canonicalForensicContent = readRootBoundFile(root, canonicalForensicRef).content;
  } catch (error) {
    return `recovery_baseline canonical recovery_baseline forensic_ref is not re-readable: ${error instanceof Error ? error.message : String(error)} (canonical forensic identity unreadable, no-write)`;
  }
  let canonicalForensic: unknown;
  try {
    canonicalForensic = JSON.parse(canonicalForensicContent);
  } catch {
    return 'recovery_baseline canonical recovery_baseline forensic_ref is not valid JSON (canonical forensic identity unreadable, no-write)';
  }
  if (!isRecord(canonicalForensic) || canonicalForensic.incident_id !== candidateIdentity) {
    return `recovery_baseline canonical recovery_baseline forensic_ref incident identity does not equal the candidate source-incident identity ${JSON.stringify(candidateIdentity)} (non-identical recovery epoch, no-write)`;
  }

  // 4) Canonical source snapshot binding: the canonical fact's
  //    source_snapshot_sha256 / source_fact_count must EXACTLY match the
  //    candidate source incident's declared source_snapshot (wrong equality /
  //    wrong version fails closed).
  const candidateSnapshot = isRecord(sourceIncident.source_snapshot) ? sourceIncident.source_snapshot : undefined;
  if (!candidateSnapshot || typeof candidateSnapshot.sha256 !== 'string' || typeof candidateSnapshot.fact_count !== 'number') {
    return 'recovery_baseline candidate source incident must declare a source_snapshot (missing source snapshot binding, no-write)';
  }
  if (canonical.source_snapshot_sha256 !== candidateSnapshot.sha256 || canonical.source_fact_count !== candidateSnapshot.fact_count) {
    return 'recovery_baseline canonical recovery_baseline source_snapshot_sha256/source_fact_count does not match the candidate source incident declared source_snapshot (wrong equality/version, no-write)';
  }

  // 5) Complete observed source fact_id uniqueness (duplicate durable fact_id
  //    evidence): ANY repeated fact_id — byte-identical or conflicting
  //    payload — makes the observed source ambiguous and fails closed no-write.
  const seenFactIds = new Set<string>();
  for (const raw of sourceFacts) {
    if (!isRecord(raw) || typeof raw.fact_id !== 'string' || raw.fact_id.length === 0) continue;
    if (seenFactIds.has(raw.fact_id)) {
      return `recovery_baseline observed source reports duplicate durable fact_id ${JSON.stringify(raw.fact_id)} (duplicate fact-id evidence, no-write)`;
    }
    seenFactIds.add(raw.fact_id);
  }
  return undefined;
}

/**
 * (SPV-S05-REC-001 F2) Expected-current-git-basis equality seam for
 * `recovery_baseline` writes: the fact's `git_basis` must EQUAL the current
 * observed Git basis (HEAD / branch / worktree) of the trust root at write
 * time — the baseline records the recovery code/authority basis it is written
 * against (contracts §2.2.4a). Non-git root, unborn HEAD or git unavailability
 * fail closed; any mismatch produces no-write. The observed worktree is the
 * root-relative path of the store root inside the git work tree (`.` when the
 * store root IS the work-tree root).
 */
function recoveryBaselineGitBasisError(root: string, expected: MesGitBasis): string | undefined {
  let observedHead: string;
  let observedBranch: string;
  let observedWorktree: string | undefined;
  try {
    observedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    observedBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    observedWorktree = gitBasisWorktree(root, toplevel);
  } catch {
    return 'current git basis is not readable at the recovery write (non-git root / unborn HEAD / git unavailable) — recovery_baseline git_basis must equal the current observed basis';
  }
  if (observedHead.length === 0 || observedBranch.length === 0 || observedWorktree === undefined) {
    return 'current git basis is not readable at the recovery write (unborn HEAD or unresolved worktree) — recovery_baseline git_basis must equal the current observed basis';
  }
  if (expected.head !== observedHead) {
    return `recovery_baseline git_basis.head ${JSON.stringify(expected.head)} does not equal the current observed HEAD ${JSON.stringify(observedHead)}`;
  }
  if (expected.branch !== observedBranch) {
    return `recovery_baseline git_basis.branch ${JSON.stringify(expected.branch)} does not equal the current observed branch ${JSON.stringify(observedBranch)}`;
  }
  if (expected.worktree !== observedWorktree) {
    return `recovery_baseline git_basis.worktree ${JSON.stringify(expected.worktree)} does not equal the current observed worktree ${JSON.stringify(observedWorktree)}`;
  }
  return undefined;
}

/** Observed worktree rel of `root` inside the git work tree (`.` when equal). */
function gitBasisWorktree(root: string, toplevel: string): string | undefined {
  try {
    const rel = path.relative(fs.realpathSync(toplevel), fs.realpathSync(root));
    return rel.length === 0 ? '.' : rel.split(path.sep).join('/');
  } catch {
    return undefined;
  }
}

/**
 * (S05-B-T01 / PO-S05-B-05 C2) Accepted-stage verification-result closure:
 * the accepted stage's `plan_binding.verification_result_ref` must
 * exact-resolve to a durable PLAN_READY PVR in the SAME persisted result set
 * (submitted ∪ retained): kind PVR + candidate binding + verdict PLAN_READY +
 * exact result_ref match + candidate Plan ref/digest promotion equality
 * (accepted_plan_ref === source_candidate_plan_ref === candidate_plan_ref) +
 * same delivery_cycle_id. Per-fact git_basis values are NEVER compared across
 * facts (each durable fact keeps its own verified basis). Missing / wrong /
 * ambiguous resolution fails closed no-write (PO-S05-B-05).
 */
function acceptedStageVerificationSupportError(
  stage: MesFactEnvelope,
  pvr: MesFactEnvelope | undefined,
): string | undefined {
  const binding = stage.plan_binding;
  if (!binding || binding.binding_stage !== 'accepted') {
    return 'accepted stage fact must bind an accepted Plan for verification closure';
  }
  const referencedRef = binding.verification_result_ref;
  if (typeof referencedRef !== 'string' || referencedRef.length === 0) {
    return 'accepted stage plan_binding.verification_result_ref must be a non-empty ref';
  }
  if (pvr === undefined) {
    return `accepted stage verification_result_ref ${JSON.stringify(referencedRef)} does not resolve to a durable PLAN_READY planning_verification_result fact in the persisted result set`;
  }
  if (pvr.fact_kind !== 'planning_verification_result') {
    return `accepted stage verification_result_ref ${JSON.stringify(referencedRef)} resolves to fact ${JSON.stringify(pvr.fact_id)} with kind ${JSON.stringify(pvr.fact_kind)} — expected planning_verification_result`;
  }
  const pvrBinding = pvr.plan_binding;
  if (!pvrBinding || pvrBinding.binding_stage !== 'candidate') {
    return `supporting PVR ${JSON.stringify(pvr.fact_id)} must bind a candidate Plan (binding_stage: "candidate")`;
  }
  if (pvrBinding.verdict !== 'PLAN_READY') {
    return `supporting PVR ${JSON.stringify(pvr.fact_id)} verdict is ${JSON.stringify(pvrBinding.verdict)} — only a PLAN_READY planning_verification_result can underpin an accepted stage`;
  }
  if (pvr.result_ref !== referencedRef) {
    return `supporting PVR ${JSON.stringify(pvr.fact_id)} result_ref ${JSON.stringify(pvr.result_ref)} must exactly equal the referenced verification_result_ref ${JSON.stringify(referencedRef)}`;
  }
  // Candidate Plan ref/digest → accepted Plan promotion equality.
  if (binding.accepted_plan_ref !== pvrBinding.candidate_plan_ref) {
    return `accepted stage accepted_plan_ref ${JSON.stringify(binding.accepted_plan_ref)} must equal the supporting PVR candidate_plan_ref ${JSON.stringify(pvrBinding.candidate_plan_ref)}（promotion 精确）`;
  }
  if (binding.source_candidate_plan_ref !== pvrBinding.candidate_plan_ref) {
    return `accepted stage source_candidate_plan_ref ${JSON.stringify(binding.source_candidate_plan_ref)} must equal the supporting PVR candidate_plan_ref ${JSON.stringify(pvrBinding.candidate_plan_ref)}（promotion 精确）`;
  }
  if ((binding.plan_digest ?? undefined) !== (pvrBinding.plan_digest ?? undefined)) {
    return `accepted stage and supporting PVR must agree on plan_digest (stage ${JSON.stringify(binding.plan_digest ?? null)} vs PVR ${JSON.stringify(pvrBinding.plan_digest ?? null)})`;
  }
  if ((binding.delivery_cycle_id ?? undefined) !== (pvrBinding.delivery_cycle_id ?? undefined)) {
    return `accepted stage and supporting PVR must carry the same delivery_cycle_id (stage ${JSON.stringify(binding.delivery_cycle_id ?? null)} vs PVR ${JSON.stringify(pvrBinding.delivery_cycle_id ?? null)})`;
  }
  return undefined;
}
/**
 * Probe the RAW snapshot path component-by-component (no-follow lstat) to
 * tell a genuinely absent pre-seed store apart from a symlink present anywhere
 * in the path. A whole-path lstat reports ENOENT both when the snapshot simply
 * does not exist and when a BROKEN (dangling) final or intermediate symlink
 * cannot resolve its target; only plain absence may be treated as an empty
 * pre-seed store (CV S01-STAGE-REVIEW-F001).
 *
 * Returns:
 *   { absent: true }              — every walked component is a plain dir/file
 *                                  (no symlink) and ENOENT was reached;
 *   { absent: false, symlinkAt }  — a symlink is present at a raw component
 *                                  (final or intermediate, broken or not);
 *   { absent: false, reason }     — non-ENOENT lstat error (also fail closed).
 */
function probeSnapshotAbsence(
  root: string,
  rel: string,
): { absent: boolean; symlinkAt?: string; reason?: string } {
  const parts = rel.split(path.sep).filter((part) => part.length > 0 && part !== '.');
  let current = root;
  for (const part of parts) {
    const next = path.join(current, part);
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { absent: true };
      }
      return { absent: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (lst.isSymbolicLink()) {
      return { absent: false, symlinkAt: next };
    }
    current = next;
  }
  // The full path exists and is symlink-free — only reachable on a probe race
  // after the whole-path ENOENT; do not declare an empty store.
  return { absent: false, reason: 'snapshot path exists during absence probe' };
}

/** Canonical JSON container written to disk. */
interface MesSnapshotContainer {
  readonly schema_version: number;
  readonly facts: readonly MesFactEnvelope[];
}

/**
 * Atomic MES snapshot store bound to one trust root.
 *
 * `root` is canonicalized through `canonicalPathWithinRoot` so a symlinked
 * or non-canonical root cannot redirect reads/writes outside the boundary.
 */
export class MesSnapshotStore {
  private readonly canonicalRoot: string;

  constructor(root: string) {
    if (typeof root !== 'string' || root.length === 0) {
      storeFail('escape', 'store root must be a non-empty path');
    }
    const canonical = canonicalPathWithinRoot(path.resolve(root), '.');
    if (canonical === null) {
      storeFail('escape', `store root "${root}" escapes the canonical trust boundary`);
    }
    this.canonicalRoot = canonical!;
  }

  get root(): string {
    return this.canonicalRoot;
  }

  /** Absolute snapshot path under the canonical root. */
  private get snapshotAbs(): string {
    return path.join(this.canonicalRoot, MES_SNAPSHOT_REL);
  }

  /**
   * Persist a validated fact set atomically.
   *
   * Every fact is validated first; a single invalid fact aborts the whole
   * write and leaves the previous snapshot untouched.
   *
   * S02 planning durable facts additionally close their relational binding
   * against the current valid snapshot at write time (see module doc); any
   * broken relation or cross-submission planning-payload conflict also
   * aborts before any file is touched.
   *
   * `task` facts: a task fact exact canonical byte-equivalent to an
   * already-durable fact in the current valid snapshot is retained without
   * re-validation against the submitted graph (cross-Stage mixed-stage
   * submission); any new/changed task fact must close its graph binding
   * against `acceptedPlanTaskGraph` (missing/invalid graph → no-write).
   */
  write(facts: readonly MesFactEnvelope[], options?: { acceptedPlanTaskGraph?: unknown }): void {
    // The public snapshot contract is an actual array, not an array-like
    // object. Guard at runtime before Array.from so {} cannot become [] and
    // replace a previously valid snapshot.
    if (!Array.isArray(facts)) {
      storeFail('invalid-fact', 'cannot persist MES snapshot: facts must be an array');
    }

    // 1) Validate ALL facts before any file operation (fail closed).
    const validated: MesFactEnvelope[] = Array.from(facts, (fact) => {
      try {
        return validateMesFactEnvelope(fact);
      } catch (err) {
        const detail =
          err instanceof SchemaValidationError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        storeFail('invalid-fact', `cannot persist MES snapshot: invalid fact: ${detail}`);
      }
    });

    // 1b) Set-level fact identity invariant (S02-C-T02 / contracts §7
    //     RESULT_INVALID), submission-scoped: ONE write must never carry two
    //     facts for the same fact_id. An IDENTICAL payload (same
    //     fact/binding/payload replay) collapses to one entry — replay
    //     returns the same disposition and no duplicate completion/acceptance
    //     is written; a DIFFERENT payload under the same fact_id fails closed
    //     before any file is touched (no-write) — the last valid snapshot
    //     stays intact.
    //
    // Scope is deliberately the single submission: the bootstrap seed retry
    // (CV-S01-B-09) legitimately REPLACES its own seed-owned fact_ids with a
    // repaired payload across submissions, so cross-submission writes are not
    // compared here (that decision belongs to the Brain write-back layer).
    const byFactId = new Map<string, MesFactEnvelope>();
    const deduped: MesFactEnvelope[] = [];
    for (const fact of validated) {
      const seen = byFactId.get(fact.fact_id);
      if (seen !== undefined) {
        if (canonicalStringify(seen) !== canonicalStringify(fact)) {
          storeFail(
            'invalid-fact',
            `cannot persist MES snapshot: duplicate fact_id ${JSON.stringify(fact.fact_id)} with a different payload within one write（契约 §7 RESULT_INVALID：冲突 no-write）`,
          );
        }
        continue; // identical duplicate within the submission — collapse
      }
      byFactId.set(fact.fact_id, fact);
      deduped.push(fact);
    }

    // 1c) (S02-SR-F001) Cross-write replay integrity, relational closure and
    //     the task-kind retention check below all need the CURRENT valid
    //     snapshot. Read it: an ABSENT snapshot (never written) is an empty
    //     store, while an unreadable / corrupt / symlinked snapshot records a
    //     read error that fails closed below for EVERY ordinary write — only
    //     the exact-source disaster recovery baseline transaction may rewrite
    //     an unrecoverable snapshot (the atomic rename replaces whatever sits
    //     at the snapshot path only when the read succeeded).
    let existingFacts: MesFactEnvelope[] = [];
    let existingReadError: MesSnapshotStoreError | undefined;
    try {
      existingFacts = this.read();
    } catch (err) {
      // (PO-S05-B-04) The read failure is recorded and fails closed below for
      // EVERY ordinary write: existingFacts stays empty only for the
      // exact-source disaster recovery baseline transaction, which validates
      // the raw snapshot content itself (never treat an unreadable current
      // snapshot as an empty store).
      existingReadError =
        err instanceof MesSnapshotStoreError
          ? err
          : new MesSnapshotStoreError('unreadable', `cannot read MES snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
    // (S05-B-T01 / PO-S05-B-04) ANY ordinary write over an unreadable /
    // corrupt / path-invalid current snapshot is never treated as an empty
    // store: the durable retained facts are invisible to the retention merge
    // when the read fails, so a rewrite would silently drop them (contracts
    // §7 RESULT_INVALID — no-write; retained facts are never silently
    // discarded). Only a submitted disaster recovery baseline — the
    // exact-source recovery seam, whose source check is raw-content based —
    // may rewrite an unrecoverable snapshot.
    const submittingRecoveryBaseline = deduped.some((fact) => fact.fact_kind === 'recovery_baseline');
    if (existingReadError !== undefined && !submittingRecoveryBaseline) {
      storeFail(
        existingReadError.code,
        `cannot persist MES snapshot: current snapshot is not re-readable (${existingReadError.message}) — write is no-write（不可读 snapshot 不得当作空 store：retained facts 不得被静默丢弃，no-write）`,
      );
    }
    const existingById = new Map<string, MesFactEnvelope>();
    for (const fact of existingFacts) existingById.set(fact.fact_id, fact);


    // (SPV-S05-REC-001 F3) Conflicting same-incident recovery epochs fail
    // closed no-write: the immutable forensic incident artifact (forensic_ref)
    // backs exactly ONE recovery epoch (one recovery_baseline fact_id per
    // incident; contracts §2.2.4a). Two recovery_baseline facts referencing the
    // same forensic incident with different fact_ids — in one submission or a
    // second epoch against a durable baseline — are a conflicting duplicate
    // (acceptance E2E-24: duplicate/conflicting epoch → no-write). Identical
    // replay of the same fact_id stays idempotent (handled elsewhere).
    const recoveryEpochByForensicRef = new Map<string, string>();
    for (const fact of deduped) {
      if (fact.fact_kind !== 'recovery_baseline') continue;
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) continue;
      const incidentRef = fact.forensic_ref!;
      const holder = recoveryEpochByForensicRef.get(incidentRef);
      if (holder !== undefined && holder !== fact.fact_id) {
        storeFail(
          'invalid-fact',
          `cannot persist recovery_baseline: conflicting recovery epochs ${JSON.stringify(holder)} and ${JSON.stringify(fact.fact_id)} reference the same forensic incident ${JSON.stringify(incidentRef)}（同一 incident 只能有一个 recovery epoch，conflict no-write）`,
        );
      }
      recoveryEpochByForensicRef.set(incidentRef, fact.fact_id);
    }
    // An unresubmitted durable baseline already occupies its incident's single
    // epoch: a submitted recovery_baseline for the same incident must not
    // introduce a second epoch alongside it.
    for (const fact of existingFacts) {
      if (fact.fact_kind !== 'recovery_baseline') continue;
      const incidentRef = fact.forensic_ref!;
      const holder = recoveryEpochByForensicRef.get(incidentRef);
      if (holder !== undefined && holder !== fact.fact_id) {
        storeFail(
          'invalid-fact',
          `cannot persist recovery_baseline: conflicting recovery epochs ${JSON.stringify(holder)} and ${JSON.stringify(fact.fact_id)} reference the same forensic incident ${JSON.stringify(incidentRef)}（同一 incident 只能有一个 recovery epoch，conflict no-write）`,
        );
      }
      recoveryEpochByForensicRef.set(incidentRef, fact.fact_id);
    }

    // Disaster recovery baseline: only a genuinely new baseline validates the
    // exact currently observed source snapshot and forensic/audit artifacts.
    for (const fact of deduped) {
      if (fact.fact_kind !== 'recovery_baseline') continue;
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) continue;
      // (SPV-S05-REC-001 F2) The baseline git_basis must EQUAL the CURRENT
      // observed HEAD/branch/worktree at write time (contracts §2.2.4a) — a
      // stale or invented basis fails closed no-write before any file op.
      const basisError = recoveryBaselineGitBasisError(this.canonicalRoot, fact.git_basis!);
      if (basisError !== undefined) {
        storeFail('invalid-fact', `cannot persist recovery_baseline: ${basisError}（恢复基线 git_basis 必须等于当前观察 basis，no-write）`);
      }
      let currentSnapshotContent: string;
      try {
        currentSnapshotContent = readRootBoundFile(this.canonicalRoot, MES_SNAPSHOT_REL).content;
      } catch (error) {
        storeFail('invalid-fact', `cannot persist recovery_baseline: current snapshot is not re-readable (${error instanceof Error ? error.message : String(error)})`);
      }
      const recoveryError = recoveryBaselineSourceError(this.canonicalRoot, fact, currentSnapshotContent!);
      if (recoveryError !== undefined) {
        storeFail(`invalid-fact`, `cannot persist recovery_baseline: ${recoveryError}（恢复基线 source/binding no-write）`);
      }
    }
    // 1d) (S03-A-T01) Task-kind durable write-through — the ONLY durable
    //     write boundary for `task` facts. A NEW/CHANGED task fact REQUIRES
    //     the brand-validated accepted_plan_task_graph (missing parameter or
    //     missing graph → fail closed no-write; other kinds never require
    //     it). The graph is forwarded to the binding validator which re-checks
    //     brand provenance, closed shape, ref / plan_digest equality,
    //     graph_digest recomputation, exact dependency edge-set equality,
    //     phantom task ids and blocked_by containment BEFORE any file op —
    //     there is no bypass direct validate→write path.
    //     (S04 mixed-stage retention) A task fact that is EXACTLY canonical
    //     byte-equivalent to an already-durable fact in the current valid
    //     snapshot is a RETAINED historical task fact: it was graph-bound at
    //     its original durable write against its own Stage's accepted Plan
    //     graph, so it must NOT be re-validated against the CURRENT
    //     submission's graph (a replace-all submission legitimately carries
    //     durable S03 facts + new S04 facts under the S04 graph). Retention is
    //     granted ONLY on byte-equivalence: a changed canonical payload under
    //     the same fact_id falls back to full graph validation below and can
    //     never borrow retention to bypass it.
    const taskGraph = options?.acceptedPlanTaskGraph;
    for (const fact of deduped) {
      if (fact.fact_kind !== 'task') continue;
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) {
        continue; // retained historical task fact — already graph-bound at its durable write
      }
      // (S03-STAGE-REVIEW-F001) Durable write-through scope closure: the
      // task_id-derived stage/slice must equal the fact scope.stage_id /
      // slice_id BEFORE any file operation — a cross-stage/slice task fact is
      // rejected no-write at the store boundary itself (the graph binding
      // validator applies the identical rule via the same helper).
      const scopeError = taskFactScopeConsistencyError(fact);
      if (scopeError !== undefined) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: task fact ${JSON.stringify(fact.fact_id)}: ${scopeError}（契约 §7 RESULT_INVALID：cross-stage/slice scope no-write）`,
        );
      }
      if (taskGraph === undefined) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: task fact ${JSON.stringify(fact.fact_id)} requires a brand-validated accepted_plan_task_graph（durable write-through：missing graph no-write）`,
        );
      }
      const graphError = validateTaskFactGraphBinding(fact, taskGraph);
      if (graphError !== undefined) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: task fact ${JSON.stringify(fact.fact_id)}: ${graphError}（契约 §7 RESULT_INVALID：graph binding fails closed no-write）`,
        );
      }
    }

    // 1e) Cross-submission planning-payload conflict (contracts §7
    //     RESULT_INVALID): if the current valid snapshot already holds a
    //     planning_verification_result / plan_acceptance fact_id, a later
    //     write with the SAME fact_id but a DIFFERENT canonical payload fails
    //     closed no-write and the previous snapshot stays byte-for-byte
    //     unchanged. Identical replay stays accepted. Only the two NORMAL
    //     planning kinds are immutable this way: S01 seed-owned facts keep
    //     their bootstrap-repair rewrite semantics (CV-S01-B-09).
    const isPlanningFact = (fact: MesFactEnvelope): boolean =>
      fact.fact_kind === 'planning_verification_result' ||
      fact.fact_kind === 'plan_acceptance';
    // (S04-B-T01) A persisted `project_ready` terminal fact is immutable the
    // same way (contracts.md §5.1 / acceptance E2E-06 / §7): identical replay
    // collapses byte-stable, a DIFFERENT canonical payload under the same
    // fact_id across submissions fails closed no-write — mirror of the
    // planning-fact retention rule.
    const isImmutableDurableFact = (fact: MesFactEnvelope): boolean =>
      isPlanningFact(fact) || fact.fact_kind === 'project_ready' || fact.fact_kind === 'recovery_baseline';
    for (const fact of deduped) {
      const previous = existingById.get(fact.fact_id);
      if (
        previous !== undefined &&
        (isImmutableDurableFact(previous) || isImmutableDurableFact(fact)) &&
        canonicalStringify(previous) !== canonicalStringify(fact)
      ) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: fact_id ${JSON.stringify(fact.fact_id)} carries a conflicting planning/terminal payload across submissions（契约 §7 RESULT_INVALID：cross-write conflict no-write）`,
        );
      }
    }

    // 1f) Relational closure for every submitted plan_acceptance (S02-SR-F001):
    //     its plan_binding.verification_result_ref must resolve to a durable
    //     PLAN_READY planning_verification_result fact in the submitted set OR
    //     the current valid snapshot (fact_kind, candidate binding_stage,
    //     verdict PLAN_READY, exact result_ref match, agreed plan ref / digest
    //     / git_basis.head). Order-independent within one submitted set (lookup
    //     by result_ref over the union). Never closes via MES status, Agent
    //     narrative, Link metadata, pane/session state or hidden conversation.
    const submittedById = new Map<string, MesFactEnvelope>();
    const verificationByResultRef = new Map<string, MesFactEnvelope>();
    const indexVerification = (fact: MesFactEnvelope): void => {
      if (fact.fact_kind === 'planning_verification_result' && fact.result_ref !== undefined) {
        if (!verificationByResultRef.has(fact.result_ref)) {
          verificationByResultRef.set(fact.result_ref, fact);
        }
      }
    };
    for (const fact of deduped) {
      submittedById.set(fact.fact_id, fact);
      indexVerification(fact);
    }
    for (const fact of existingFacts) indexVerification(fact);
    for (const fact of deduped) {
      if (fact.fact_kind !== 'plan_acceptance') continue;
      // Envelope validation guarantees an accepted binding here; narrow the
      // union so TS can see verification_result_ref.
      const ref =
        fact.plan_binding !== undefined && fact.plan_binding.binding_stage === 'accepted'
          ? fact.plan_binding.verification_result_ref
          : undefined;
      if (ref === undefined) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: plan_acceptance ${JSON.stringify(fact.fact_id)} has no verification_result_ref（missing relation，no-write）`,
        );
      }
      const relationError = verifyPlanAcceptanceSupport(
        fact,
        ref !== undefined ? verificationByResultRef.get(ref) : undefined,
      );
      if (relationError !== undefined) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: ${relationError}（契约 §7 RESULT_INVALID：relational binding fails closed，no-write）`,
        );
      }
    }

    // 1f-2) (S05-A-T01 residual) New-vs-retained legacy planning shape closure.
    // A submitted PVR/PA in the FULLY legacy shape (neither scope.stage_id nor
    // plan_binding.delivery_cycle_id — contracts §2.2.2 / architecture
    // delivery-cycle-semantics) is lawful ONLY as a byte-identical replay of an
    // ALREADY-retained fact with the same fact_id (history-only, no upgrade;
    // retained canonical-equivalent legacy facts keep rehydrating
    // byte-equivalently). A NEW fact_id or a CHANGED payload in the fully legacy
    // shape is a current NORMAL planning fact lacking scope/cycle and fails
    // closed no-write (contracts §7 RESULT_INVALID) — the schema pair rule alone
    // cannot see this because the legacy shape must stay legal for retained
    // rehydration, so the store closes the new-vs-retained distinction against
    // the CURRENT valid snapshot.
    for (const fact of deduped) {
      if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') continue;
      const scope = isRecord(fact.scope) ? fact.scope : undefined;
      const binding = isRecord(fact.plan_binding) ? fact.plan_binding : undefined;
      const hasCycle = binding !== undefined && binding.delivery_cycle_id !== undefined;
      const hasStageScope = scope !== undefined && typeof scope.stage_id === 'string';
      if (hasCycle || hasStageScope) continue; // current NORMAL shape — pair rule governs
      const previous = existingById.get(fact.fact_id);
      if (previous === undefined || canonicalStringify(previous) !== canonicalStringify(fact)) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: NORMAL planning fact ${JSON.stringify(fact.fact_id)} in the fully legacy shape (no scope.stage_id / plan_binding.delivery_cycle_id) is only lawful as a byte-identical replay of a retained fact（契约 §7 RESULT_INVALID：legacy 形状仅允许 retained replay，新提交/变更 no-write）`,
        );
      }
    }

    // 1f-2b) (S06-D-T01 / PO-S06-D-02) New-vs-retained terminal successor
    // shape closure. A SUBMITTED cycle-bearing `project_ready` (non-empty
    // top-level delivery_cycle_id) WITHOUT `supersedes_project_ready_ref` is
    // the pre-update legacy_cycle_anchor shape: lawful ONLY as a
    // byte-identical replay of an ALREADY-retained fact (history-only, no
    // backfill / rewrite / re-emit; oracle: retained pre-update anchors may
    // omit only the predecessor field). A NEW fact_id or CHANGED payload in
    // that shape is a half-new NORMAL terminal and fails closed no-write
    // (contracts §7 RESULT_INVALID) — new NORMAL cycle-bearing terminals must
    // carry supersedes_project_ready_ref (null = new chain root, else the
    // exact preceding chain-tip fact_id).
    for (const fact of deduped) {
      if (fact.fact_kind !== 'project_ready') continue;
      const cycle = fact.delivery_cycle_id;
      if (cycle === undefined || cycle.length === 0) continue; // no-cycle legacy terminal — history-only
      if (fact.supersedes_project_ready_ref !== undefined) continue; // full new NORMAL shape
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) continue;
      storeFail(
        'invalid-fact',
        `cannot persist MES snapshot: cycle-bearing project_ready ${JSON.stringify(fact.fact_id)} without supersedes_project_ready_ref is a half-new NORMAL terminal shape — lawful only as a byte-identical replay of a retained pre-update legacy_cycle_anchor（契约 §7 RESULT_INVALID：half-new no-write）`,
      );
    }

    // 1f-2c) (S06 post-recovery Authority update) New-vs-retained accepted-Plan
    // generation successor shape closure. A SUBMITTED cycle-bearing
    // `plan_acceptance` generation (non-empty plan_binding.delivery_cycle_id)
    // WITHOUT `supersedes_plan_acceptance_ref` is the pre-update compatibility
    // root shape: lawful ONLY as a byte-identical replay of an ALREADY-retained
    // fact (history-only, no backfill / rewrite / re-emit). A NEW fact_id or
    // CHANGED payload in that shape is a half-new NORMAL generation and fails
    // closed no-write (contracts §2.2.2 / §7 RESULT_INVALID): new cycle-bearing
    // generations must carry the top-level predecessor edge (null = new chain
    // root only when no other generation for the (stage, cycle) exists, else
    // the exact retained chain-tip fact_id).
    for (const fact of deduped) {
      if (fact.fact_kind !== 'plan_acceptance') continue;
      const binding = fact.plan_binding;
      if (binding === undefined || binding.binding_stage !== 'accepted') continue;
      const cycle = binding.delivery_cycle_id;
      if (cycle === undefined || cycle.length === 0) continue; // no-cycle legacy acceptance — history-only
      if (fact.supersedes_plan_acceptance_ref !== undefined) continue; // full new NORMAL shape
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) continue;
      storeFail(
        'invalid-fact',
        `cannot persist MES snapshot: cycle-bearing plan_acceptance ${JSON.stringify(fact.fact_id)} without supersedes_plan_acceptance_ref is a half-new NORMAL generation shape — lawful only as a byte-identical replay of a retained pre-update generation（契约 §7 RESULT_INVALID：half-new no-write）`,
      );
    }
    // 1f-2d) Stale-predecessor closure against the RETAINED chain tip: a
    // submitted NEW/CHANGED generation whose predecessor is a string must point
    // at the tip of its (stage, cycle) chain as it exists in the RETAINED
    // snapshot (the submit-time basis); an out-of-date edge is no-write. The
    // successor-graph closure below additionally rejects branches / cycles /
    // multiple tips in the whole resulting set.
    const retainedTips = resolvePlanAcceptanceGenerationTips(existingFacts);
    const retainedTipByGroup = new Map<string, string>();
    if (retainedTips.ok) {
      for (const tip of retainedTips.tips) {
        const tipBinding = tip.plan_binding;
        if (tipBinding === undefined || tipBinding.binding_stage !== 'accepted') continue;
        const tipCycle = tipBinding.delivery_cycle_id;
        const tipStage = tip.scope?.stage_id;
        if (typeof tipStage !== 'string' || typeof tipCycle !== 'string') continue;
        retainedTipByGroup.set(canonicalStringify([tipStage, tipCycle]), tip.fact_id);
      }
    }
    const generationGroupCount = new Map<string, number>();
    const countedGenerationIds = new Set<string>();
    for (const candidate of [...existingFacts, ...deduped]) {
      if (!isCycleBearingPlanAcceptanceGeneration(candidate)) continue;
      if (countedGenerationIds.has(candidate.fact_id)) continue;
      countedGenerationIds.add(candidate.fact_id);
      const candidateCycle = candidate.plan_binding!.delivery_cycle_id as string;
      const candidateStage = candidate.scope!.stage_id;
      const groupKey = canonicalStringify([candidateStage, candidateCycle]);
      generationGroupCount.set(groupKey, (generationGroupCount.get(groupKey) ?? 0) + 1);
    }
    for (const fact of deduped) {
      if (fact.fact_kind !== 'plan_acceptance') continue;
      const binding = fact.plan_binding;
      if (binding === undefined || binding.binding_stage !== 'accepted') continue;
      const cycle = binding.delivery_cycle_id;
      const stageId = fact.scope?.stage_id;
      const predecessor = fact.supersedes_plan_acceptance_ref;
      if (cycle === undefined || cycle.length === 0 || typeof stageId !== 'string') continue;
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) continue; // byte-identical retained replay — history-only
      if (predecessor === null) {
        // (S06 post-recovery Authority update) `null` is lawful for a NEW
        // generation only when no OTHER cycle-bearing generation for the same
        // (stage, cycle) exists in submitted ∪ retained facts (contracts §2.2.2).
        const groupKey = canonicalStringify([stageId, cycle]);
        if ((generationGroupCount.get(groupKey) ?? 1) > 1) {
          storeFail(
            'invalid-fact',
            `cannot persist MES snapshot: plan_acceptance generation ${JSON.stringify(fact.fact_id)} declares a null predecessor but (stage ${JSON.stringify(stageId)}, cycle ${JSON.stringify(cycle)}) already carries another cycle-bearing generation（契约 §7 RESULT_INVALID：null 仅当不存在其它 generation，no-write）`,
          );
        }
        continue;
      }
      if (typeof predecessor !== 'string' || predecessor.length === 0) continue; // malformed value handled by schema validation
      const retainedTip = retainedTipByGroup.get(canonicalStringify([stageId, cycle]));
      if (retainedTip !== predecessor) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: plan_acceptance generation ${JSON.stringify(fact.fact_id)} predecessor ${JSON.stringify(predecessor)} is not the RETAINED (stage ${JSON.stringify(stageId)}, cycle ${JSON.stringify(cycle)}) chain tip ${JSON.stringify(retainedTip ?? null)}（契约 §7 RESULT_INVALID：stale predecessor no-write）`,
        );
      }
    }

    // 1g) Durable support facts are immutable once persisted: existing
    //     planning facts NOT resubmitted are preserved so a partial write
    //     never silently drops the PLAN_READY verification that durably
    //     supports an acceptance in the SAME snapshot. (S04-B-T01) The same
    //     retention covers the terminal / accepted-stage support /
    //     Review→Finding relation facts (E2E-06 / STATIC-29 / contracts.md
    //     §2.1.1): an unresubmitted `project_ready` fact, a durable
    //     accepted-stage support `stage` fact (machine-closed predicate) and
    //     durable `finding` / `finding_disposition` relation facts are merged
    //     into the new snapshot — a partial write never silently drops the
    //     durable support behind a terminal or Review→Finding relation, and
    //     every retained fact keeps its OWN git_basis (different heads are
    //     legal; the terminal relation binds by planned-set equality, not by
    //     basis equality). Every other kind keeps the S01 replace-all
    //     semantics.
    const isRetainedExistingFact = (fact: MesFactEnvelope): boolean =>
      isPlanningFact(fact) ||
      fact.fact_kind === 'project_ready' ||
      (fact.fact_kind === 'stage' && isDurableAcceptedStageSupport(fact)) ||
      fact.fact_kind === 'finding' ||
      fact.fact_kind === 'finding_disposition' ||
      fact.fact_kind === 'recovery_baseline';
    const merged: MesFactEnvelope[] = [...deduped];
    for (const fact of existingFacts) {
      // (S06-R-F-T01 bounded recovery) A controlled recovery_baseline write
      // preserves the ENTIRE pre-baseline observed source as history-only
      // retained facts: contracts §2.2.4a requires existing retained facts
      // to remain unreconstructed/unupgraded until fresh rehydrate +
      // relational audit proves current use, and the incident's read-only
      // audit asserts 'misbound facts retained in source'. The NORMAL
      // replace-all ∪ retained-support-subset merge below would silently
      // drop non-retained kinds (work/task/result/git — the six S06-D
      // misbound facts in the real 130-fact snapshot), materializing the
      // recovery relation-set incompleteness. Under submittingRecoveryBaseline
      // the FULL existing fact set merges unchanged; an explicit resubmission
      // in THIS write still wins over the retained byte-equivalent.
      if (submittingRecoveryBaseline) {
        if (!submittedById.has(fact.fact_id)) merged.push(fact);
        continue;
      }
      if (!isRetainedExistingFact(fact)) continue;
      if (!submittedById.has(fact.fact_id)) merged.push(fact);
    }

    // 1g-2) (S05-B-T01 / PO-S05-B-01) NORMAL cross-fact cycle equality write
    //       invariant over the RESULTING set (submitted ∪ retained):
    //       - the unique current candidate/accepted planning binding cycle is the
    //         single distinct delivery_cycle_id among the PVR/PA facts of the
    //         resulting set; ≥2 distinct cycles are ambiguous and no-write; no
    //         cycle-bearing planning binding = legacy-only store (retained legacy
    //         facts stay read-only history, no backfill);
    //       - every NEW/CHANGED plan-bound fact (fact carrying plan_binding,
    //         excluding the S01 seed-owned `plan_binding` kind which keeps
    //         bootstrap-repair rewrite semantics, CV-S01-B-09) must carry exactly
    //         that unique current cycle — missing (缺失) / cross-cycle (跨 cycle)
    //         / ambiguous → no-write, keeping the last valid snapshot
    //         byte-identical (contracts §7 RESULT_INVALID);
    //       - a NEW/CHANGED cycle-bearing durable accepted-stage support closes
    //         its full NORMAL stage relation (PO-S05-B-05 / review-result-contract
    //         / E2E-23 / STATIC-30): stage.plan_binding.verification_result_ref
    //         must exact-resolve to the durable PLAN_READY PVR of the same cycle
    //         (candidate Plan ref/digest promotion equality; per-fact git_basis
    //         NEVER compared) and stage.result_ref must exact-resolve to the
    //         same-stage / same-accepted-Plan / same-cycle Review-owned stage-only
    //         `result` (verifyAcceptedStageReviewResultSupport) —
    //         execute/generic/opaque results cannot masquerade;
    //         wrong/missing/ambiguous → no-write; retained historical accepted
    //         stages (no cycle) stay legacy-compatible.
    // (S06 runtime-unblock / post-S05 new planning cycle) A cycle ALREADY
    // CLOSED by a legal matching cycle-bearing PROJECT_READY terminal in the
    // RETAINED snapshot is HISTORY-ONLY: its retained PVR/PA facts do NOT
    // count as a distinct current planning binding, so a NEW unique OPEN
    // cycle's pre-accept PVR/PA can be durably written next to it while the
    // closed cycle's facts stay byte-equivalent (contracts §2.2.2 /
    // architecture delivery-cycle-semantics). "Legal matching" = the retained
    // terminal carries the SAME top-level delivery_cycle_id AND its own
    // planned-set closure validates over the resulting set
    // (verifyProjectReadySupportError === undefined) — a broken terminal
    // never masquerades as history-only and still fails closed at the
    // terminal closure below. A terminal first submitted in THIS write does
    // not close the cycle yet (one atomic write may open and close its own
    // cycle).
    const closedTerminalCycles = new Set<string>();
    for (const fact of existingFacts) {
      if (fact.fact_kind !== 'project_ready') continue;
      const cycle = fact.delivery_cycle_id;
      if (cycle === undefined || cycle.length === 0) continue; // legacy terminal — no NORMAL cycle to close
      if (verifyProjectReadySupportError(fact, merged) !== undefined) continue; // broken terminal — never history-only
      closedTerminalCycles.add(cycle);
    }
    // (CV-S06-D-recovery-cv-1 / PO-S06-D-01) A cycle ALREADY CLOSED by a legal
    // matching cycle-bearing PROJECT_READY terminal in the RETAINED snapshot is
    // history-only for its planning facts too: a NEW/CHANGED NORMAL PVR/PA
    // (new fact_id or changed payload) must NOT reopen or append to that closed
    // delivery_cycle_id — only a byte-identical replay of an ALREADY-retained
    // closed-cycle PVR/PA stays legal (history-only rehydration; contracts §2.2.2
    // / §2.5 / §7 RESULT_INVALID, E2E-23 / STATIC-30: closed-cycle retained
    // planning facts are durable history and never accept write-through).
    for (const fact of deduped) {
      if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') continue;
      const cycle = fact.plan_binding?.delivery_cycle_id;
      if (cycle === undefined || cycle.length === 0) continue; // legacy no-cycle — history-only
      if (!closedTerminalCycles.has(cycle)) continue; // open/unknown cycle — other checks govern
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) continue; // byte-identical retained replay — history-only
      storeFail(
        'invalid-fact',
        `cannot persist MES snapshot: NEW/CHANGED planning fact ${JSON.stringify(fact.fact_id)} claims delivery_cycle_id ${JSON.stringify(cycle)} already CLOSED by a legal matching cycle-bearing PROJECT_READY terminal — closed-cycle planning facts are history-only and never accept new/changed PVR/PA（契约 §7 RESULT_INVALID：closed cycle no-write）`,
      );
    }
    const planningBindingCycles = new Set<string>();
    for (const fact of merged) {
      if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') continue;
      const cycle = fact.plan_binding?.delivery_cycle_id;
      if (cycle !== undefined && cycle.length > 0 && !closedTerminalCycles.has(cycle)) planningBindingCycles.add(cycle);
    }
    if (planningBindingCycles.size > 1) {
      storeFail(
        'invalid-fact',
        `cannot persist MES snapshot: ambiguous current planning bindings carry ${planningBindingCycles.size} distinct OPEN delivery_cycle_id values（契约 §7 RESULT_INVALID：重复/ambiguous，no-write）`,
      );
    }
    const currentCycle = planningBindingCycles.size === 1 ? [...planningBindingCycles][0] : undefined;

    // (S06 post-recovery Authority update; supersedes the CV-S06-D-cv-2
    // same-identity uniqueness closure) Verification evidence and accepted
    // generations are distinct:
    //   - `planning_verification_result` is verification evidence only. Multiple
    //     DISTINCT PVR facts for the same (stage, cycle, candidate plan ref,
    //     digest) are LEGAL (fresh re-verification on a new Authority/Git
    //     basis), so no same-identity PVR uniqueness closure exists (contracts
    //     §2.2.2 / architecture #/entities/planning-acceptance-succession). Two
    //     PVR facts sharing ONE durable `result_ref` stay ambiguous and fail
    //     closed in the exact-resolution closure below (§2.1.3).
    //   - a cycle-bearing `plan_acceptance` is one accepted Plan generation;
    //     the same (stage, cycle) may legally carry SEVERAL generations (with
    //     the same or a different accepted ref / digest) as long as they form
    //     the append-only chain validated by
    //     `verifyPlanAcceptanceSuccessionGraphError` below. Generation identity
    //     is decided by the chain structure alone — never by (ref, digest),
    //     fingerprint, insertion order or newest-wins.


    // (CV-S05-B-01) The per-fact cycle equality check runs UNCONDITIONALLY over
    // every NEW/CHANGED execute-owned NORMAL plan-bound fact — not only when a
    // current cycle anchor exists. A cycle-bearing NORMAL execute fact
    // (work/task/result/git/finding/finding_disposition carrying
    // delivery_cycle_id) requires a UNIQUE current candidate/accepted planning
    // binding (PVR/PA anchor) carrying exactly that cycle in the resulting set;
    // without it the write fails closed no-write (contracts §7 RESULT_INVALID)
    // because the cycle identity would be orphaned, not NORMAL. Terminal-layer
    // cycle-bearing accepted-stage supports keep the S05-D legacy coexistence
    // semantics (CV S05-D-cv-1 / E2E-23: historical and current terminals with
    // the same planned set coexist and rebuild independently even before a
    // planning anchor exists) — they are re-checked only once a unique current
    // cycle exists. Old retained history stays readable: byte-identical
    // retained replay keeps its history-only pass, and a fully legacy store
    // (no PVR/PA anchor at all) keeps accepting only legacy-shaped (no-cycle)
    // execute facts.
    const isExecuteOwnedPlanFact = (fact: MesFactEnvelope): boolean =>
      fact.fact_kind === 'work' ||
      fact.fact_kind === 'task' ||
      fact.fact_kind === 'result' ||
      fact.fact_kind === 'git' ||
      fact.fact_kind === 'finding' ||
      fact.fact_kind === 'finding_disposition';
    for (const fact of deduped) {
      if (fact.plan_binding === undefined) continue; // not plan-bound
      if (fact.fact_kind === 'plan_binding') continue; // S01 seed-owned bootstrap fact (CV-S01-B-09)
      const previous = existingById.get(fact.fact_id);
      if (previous !== undefined && canonicalStringify(previous) === canonicalStringify(fact)) continue; // byte-identical retained replay — history-only
      if (currentCycle === undefined) {
        // (CV-S05-B-01) No PVR/PA anchor: a cycle-bearing execute-owned NORMAL
        // plan-bound fact is an orphaned cycle identity — no-write.
        if (isExecuteOwnedPlanFact(fact) && fact.plan_binding.delivery_cycle_id !== undefined) {
          storeFail(
            'invalid-fact',
            `cannot persist MES snapshot: cycle-bearing execute plan-bound fact ${JSON.stringify(fact.fact_id)} delivery_cycle_id ${JSON.stringify(fact.plan_binding.delivery_cycle_id)} has no unique current candidate/accepted planning binding (PVR/PA anchor) in the resulting set（契约 §7 RESULT_INVALID：孤儿 cycle identity，no-write）`,
          );
        }
        // (CV-S05-B-01-STAGE / recheck-1 + recheck-2 guard) A NEW/CHANGED
        // cycle-bearing accepted stage with NO PVR/PA anchor can only be
        // authorized by E2E-23 terminal coexistence — NOT by a bare
        // same-cycle PROJECT_READY terminal alone (CE-S05-B-01-STAGE-TERMINAL):
        // the terminal cycle can only be validated after the accepted stage
        // has its authoritative PVR/PA/Review closure, and a bare terminal
        // must never anchor or authorize a new cycle-bearing accepted stage
        // when PVR/PA and Review result are absent. Legal terminal-layer
        // coexistence (S05-D / CV S05-D-cv-1 / E2E-23) requires BOTH:
        //   (a) a same-cycle cycle-bearing PROJECT_READY terminal in the
        //       resulting set (plan-bound facts carry cycle in plan_binding,
        //       PROJECT_READY carries top-level cycle ID), AND
        //   (b) a legacy (no-cycle) accepted-stage support cohort in the same
        //       resulting set — historical and current terminals with the
        //       same planned set coexist and rebuild independently.
        // A cycle-bearing accepted stage with no PVR/PA anchor and no such
        // legacy-coexistence terminal relation is an orphaned cycle identity
        // and fails closed no-write; legacy no-cycle retained stages stay
        // history-only.
        if (
          fact.fact_kind === 'stage' &&
          isDurableAcceptedStageSupport(fact) &&
          fact.plan_binding.delivery_cycle_id !== undefined
        ) {
          const stageCycle = fact.plan_binding.delivery_cycle_id;
          const hasLegacyCoexistenceCohort = merged.some(
            (f) =>
              (f.fact_kind === 'stage' &&
                isDurableAcceptedStageSupport(f) &&
                (f.plan_binding?.delivery_cycle_id ?? undefined) === undefined) ||
              (f.fact_kind === 'project_ready' &&
                (f.delivery_cycle_id ?? undefined) === undefined),
          );
          const anchoredByTerminal = merged.some(
            (f) => f.fact_kind === 'project_ready' && f.delivery_cycle_id === stageCycle,
          );
          if (!(hasLegacyCoexistenceCohort && anchoredByTerminal)) {
            storeFail(
              'invalid-fact',
              `cannot persist MES snapshot: cycle-bearing accepted stage ${JSON.stringify(fact.fact_id)} delivery_cycle_id ${JSON.stringify(stageCycle)} has no PVR/PA anchor and is not authorized by a legacy-coexistence same-cycle cycle-bearing PROJECT_READY terminal relation in the resulting set（契约 §7 RESULT_INVALID：孤儿 cycle identity，no-write）`,
            );
          }
        }
        continue; // legacy no-cycle / terminal-anchored facts keep their pass
      }
      const factCycle = fact.plan_binding.delivery_cycle_id;
      if (factCycle !== currentCycle) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: plan-bound fact ${JSON.stringify(fact.fact_id)} delivery_cycle_id ${JSON.stringify(factCycle ?? null)} must exactly equal the unique current planning binding cycle ${JSON.stringify(currentCycle)}（契约 §7 RESULT_INVALID：缺失/跨 cycle，no-write）`,
        );
      }
    }

    if (currentCycle !== undefined) {
      // Order-independent exact resolution over the WHOLE resulting set
      // (submitted ∪ retained): durable PVRs and result facts indexed by
      // result_ref so a stage written before its support in one submission
      // still closes (S02-SR-F001 order-independence; per-fact git_basis
      // values are never compared across facts).
      const pvrByResultRef = new Map<string, MesFactEnvelope>();
      const resultByResultRef = new Map<string, MesFactEnvelope[]>();
      for (const fact of merged) {
        if (fact.fact_kind === 'planning_verification_result' && fact.result_ref !== undefined) {
          // (CV-S06-D-cv-1, extends CV-S05-B-05-PVR) Duplicate DISTINCT PVR
          // facts resolving to the SAME result_ref are ambiguous verification
          // anchors — the accepted stage could not exact-resolve to exactly one
          // durable PLAN_READY verification, so the write fails closed no-write
          // (contracts §7 RESULT_INVALID / E2E-23 / STATIC-30). Verdict-agnostic:
          // a FINDINGS/BLOCKED PVR shadowing a PLAN_READY PVR (or vice versa)
          // under one result_ref is still a duplicate planning binding and must
          // fail closed; byte-identical replay of the SAME fact_id stays legal.
          const prior = pvrByResultRef.get(fact.result_ref);
          if (prior !== undefined && prior.fact_id !== fact.fact_id) {
            storeFail(
              'invalid-fact',
              `cannot persist MES snapshot: ambiguous planning_verification_result anchors for result_ref ${JSON.stringify(fact.result_ref)}: facts ${JSON.stringify(prior.fact_id)} and ${JSON.stringify(fact.fact_id)}（契约 §7 RESULT_INVALID：duplicate distinct PVR，no-write）`,
            );
          }
          if (!pvrByResultRef.has(fact.result_ref)) pvrByResultRef.set(fact.result_ref, fact);
        }
        if (fact.fact_kind === 'result' && fact.result_ref !== undefined) {
          const list = resultByResultRef.get(fact.result_ref) ?? [];
          list.push(fact);
          resultByResultRef.set(fact.result_ref, list);
        }
      }
      // (CV-S05-B-05-RETAINED) The accepted-stage relation closure validates
      // EVERY cycle-bearing durable accepted-stage support in the WHOLE
      // resulting set (submitted ∪ retained) on EVERY write — retained stage
      // facts included. Iterating only the submitted set (and skipping
      // byte-identical replays) let a submitted replacement drift a retained
      // stage's result_ref/verification_ref resolution and persist a broken
      // relation without failing closed; the relation closure binds the
      // resulting set, so retained cycle-bearing accepted stages are
      // re-validated against the merged PVR/result indexes (execute/generic
      // result masquerade → no-write). Legacy-shaped retained accepted stages
      // (no cycle) keep their history-only legacy-compatible pass.
      for (const fact of merged) {
        if (fact.fact_kind !== 'stage') continue;
        if (!isDurableAcceptedStageSupport(fact)) continue;
        if ((fact.plan_binding?.delivery_cycle_id ?? undefined) !== currentCycle) continue; // legacy-shaped accepted stage — no NORMAL closure
        // (a) stage.plan_binding.verification_result_ref → durable PLAN_READY PVR
        const stageBinding = fact.plan_binding;
        const verificationRef =
          stageBinding !== undefined && stageBinding.binding_stage === 'accepted'
            ? stageBinding.verification_result_ref
            : undefined;
        const pvr = verificationRef !== undefined ? pvrByResultRef.get(verificationRef) : undefined;
        const verificationError = acceptedStageVerificationSupportError(fact, pvr);
        if (verificationError !== undefined) {
          storeFail(
            'invalid-fact',
            `cannot persist MES snapshot: ${verificationError}（契约 §7 RESULT_INVALID：accepted-stage verification relation fails closed，no-write）`,
          );
        }
        // (b) stage.result_ref → unique Review-owned stage-only result (same cycle)
        const stageResultRef = fact.result_ref;
        const resultMatches = stageResultRef !== undefined ? (resultByResultRef.get(stageResultRef) ?? []) : [];
        if (resultMatches.length !== 1) {
          storeFail(
            'invalid-fact',
            `cannot persist MES snapshot: accepted stage ${JSON.stringify(fact.fact_id)} result_ref ${JSON.stringify(stageResultRef)} must exact-resolve to exactly one durable Review-owned result fact（契约 §7 RESULT_INVALID：missing/ambiguous，no-write）`,
          );
        }
        const reviewError = verifyAcceptedStageReviewResultSupport(fact, resultMatches[0]);
        if (reviewError !== undefined) {
          storeFail(
            'invalid-fact',
            `cannot persist MES snapshot: ${reviewError}（契约 §7 RESULT_INVALID：review→stage relation fails closed，no-write）`,
          );
        }
      }
    }


    // 1h) (S04-B-T01) `project_ready` terminal write-through relational
    //     closure (contracts.md §5.1 / acceptance E2E-06 / §7): the closed
    //     planned Stage-ID set must EXACTLY equal the durable accepted-stage
    //     support set in the SAME persisted result set (submitted ∪ retained
    //     facts) — missing / duplicate / unsorted / extra / mismatch fail
    //     closed no-write (RESULT_INVALID / RESULT_BINDING_MISMATCH). MES
    //     never reads the Project Stage Map: the planned set is expressed
    //     through the fact payload by Brain. Per-fact git_basis values are
    //     never compared (each support fact keeps its own verified basis;
    //     the relation binds by planned-set equality only).
    // (CV-S04-B-cv-2) The exact closure must hold for the WHOLE persisted
    // result set on EVERY write — retained facts included. Iterating only
    // the submitted set let a later support-only write drift a retained
    // `project_ready` (e.g. adding S04 support without resubmitting the
    // terminal) and persist a broken terminal relation without failing
    // closed; exact closure semantics bind the resulting set (submitted ∪
    // retained), so every `project_ready` in it is re-validated on each write.
    for (const fact of merged) {
      if (fact.fact_kind !== 'project_ready') continue;
      const closureError = verifyProjectReadySupportError(fact, merged);
      if (closureError !== undefined) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: ${closureError}（契约 §7 RESULT_INVALID：terminal relation fails closed，no-write）`,
        );
      }
    }


    // 1h-2) (S06-D-T01 / PO-S06-D-02) Terminal succession graph atomic
    //       validation over the WHOLE resulting set (submitted ∪ retained):
    //       all cycle-bearing `project_ready` terminals must form ONE
    //       restartable acyclic successor chain. Each non-null
    //       supersedes_project_ready_ref resolves by EXACT fact_id to a
    //       legal cycle-bearing terminal with a DIFFERENT delivery_cycle_id;
    //       self-reference, missing / non-terminal / no-cycle-legacy target,
    //       duplicate target (branch), repeated cycle ID and directed cycle
    //       fail closed; the chain must have exactly one tip (the terminal
    //       not referenced by any successor) — zero or multiple tips are
    //       fail closed. A retained pre-update legacy_cycle_anchor (cycle
    //       with omitted predecessor) is a read-only compatibility root and
    //       may anchor a new chain; no-cycle legacy terminals are history
    //       and never join. The graph is a pure function of the durable
    //       facts, so snapshot replacement / restart / rehydrate rebuilds
    //       the same chain and tip (oracle: "restart/rehydrate 保留相同 edge
    //       values（含 anchor 的 omitted predecessor）→ 重建同一 chain/tip").
    const projectReadyFacts = merged.filter((fact) => fact.fact_kind === 'project_ready');
    const successionError = verifyProjectReadySuccessionGraphError(projectReadyFacts);
    if (successionError !== undefined) {
      storeFail(
        'invalid-fact',
        `cannot persist MES snapshot: ${successionError}（契约 §7 RESULT_INVALID：terminal succession graph fails closed，no-write）`,
      );
    }
    // 1h-3) (S06 post-recovery Authority update) Accepted-Plan generation
    //       succession graph atomic validation over the WHOLE resulting set
    //       (submitted ∪ retained): every (stage, delivery cycle) group of
    //       cycle-bearing `plan_acceptance` generations must form exactly ONE
    //       append-only acyclic chain whose unique tip is the current accepted
    //       generation. self-reference, missing / non-generation / cross-stage /
    //       cross-cycle target, duplicate target (branch), directed cycle, an
    //       explicit null predecessor next to another generation, and zero /
    //       multiple tips all fail closed (contracts §2.2.2 / §2.1.3 / §7
    //       RESULT_INVALID). The chain is a pure function of the durable facts,
    //       so restart / rehydrate rebuilds the same chain and the same tip.
    const planAcceptanceSuccessionError = verifyPlanAcceptanceSuccessionGraphError(merged);
    if (planAcceptanceSuccessionError !== undefined) {
      storeFail(
        'invalid-fact',
        `cannot persist MES snapshot: ${planAcceptanceSuccessionError}（契约 §7 RESULT_INVALID：planning acceptance succession graph fails closed，no-write）`,
      );
    }
    // 1i) (S04-B-T01) `finding_disposition.finding_ref` durable unique
    //     resolution (STATIC-29 Review→Finding unique mapping, contracts.md
    //     §2.1.1 / §2.2.3 / §7): the ref must resolve by EXACT fact_id to
    //     exactly one durable `finding` fact in the SAME persisted result set
    //     (submitted ∪ retained facts — the retained durable `finding` /
    //     `finding_disposition` relation facts are part of it). Missing /
    //     ambiguous / non-finding resolution fail closed no-write; partial
    //     terminal/support writes never drop the relation supports and
    //     restart re-reads the same durable facts to rebuild the same
    //     unique mapping.
    // (CV-S04-B-cv-2) The unique resolution must hold for the WHOLE
    // persisted result set on EVERY write — retained facts included.
    // Iterating only the submitted set let a later write shadow a durable
    // `finding` (same fact_id, non-finding kind) and persist a retained
    // disposition whose finding_ref no longer resolves; the durable
    // Review→Finding mapping (STATIC-29) must stay exactly closed.
    for (const fact of merged) {
      if (fact.fact_kind !== 'finding_disposition') continue;
      const resolutionError = resolveFindingDispositionRefError(fact, merged);
      if (resolutionError !== undefined) {
        storeFail(
          'invalid-fact',
          `cannot persist MES snapshot: ${resolutionError}（契约 §7 RESULT_INVALID：review→finding relation fails closed，no-write）`,
        );
      }
    }
    // 2) Canonical container (deterministic re-read after restart).
    const container: MesSnapshotContainer = {
      schema_version: MES_SCHEMA_VERSION,
      facts: merged,
    };
    const content = canonicalStringify(container);

    // 3) Resolve + prepare the `.proofloop/mes` directory root-bound.
    const dir = path.dirname(this.snapshotAbs);
    const canonicalDir = canonicalPathWithinRoot(this.canonicalRoot, dir);
    if (canonicalDir === null) {
      storeFail('escape', `snapshot directory "${dir}" escapes the trust root`);
    }
    try {
      fs.mkdirSync(canonicalDir!, { recursive: true });
    } catch (err) {
      storeFail(
        'write-failed',
        `cannot create snapshot directory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4) Temp file (O_EXCL) + fsync + atomic rename over the previous snapshot.
    const tmp = path.join(
      canonicalDir!,
      `.snapshot.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'wx');
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, this.snapshotAbs);
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      storeFail(
        'write-failed',
        `cannot atomically persist MES snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Read + validate the persisted snapshot.
   *
   * A missing snapshot (empty pre-seed store) returns `[]`; any present but
   * invalid state (escape / symlink / invalid UTF-8 / TOCTOU / corrupt JSON /
   * invalid fact) fails closed — never partial facts.
   */
  read(): MesFactEnvelope[] {
    // Root-bound validation of the FULL snapshot path (including every
    // ancestor component) BEFORE any missing-store shortcut: an
    // intermediate symlink escape (root/.proofloop or root/.proofloop/mes
    // -> outside) must fail closed even when the escaped target has no
    // snapshot, instead of being misreported as an empty pre-seed store.
    const canonical = canonicalPathWithinRoot(this.canonicalRoot, MES_SNAPSHOT_REL);
    if (canonical === null) {
      storeFail('escape', `MES snapshot path "${MES_SNAPSHOT_REL}" escapes the trust root (symlink ancestor)`);
    }
    const canonicalSnapshot = canonical!;

    // lstat (no-follow) on the ROOT-BOUND canonical path: a symlink at the
    // final component is NOT treated as an empty store; it is passed to
    // readRootBoundFile which rejects it. A BROKEN (dangling) final or
    // intermediate symlink makes the whole-path lstat report ENOENT exactly
    // like a genuinely absent snapshot — probe the RAW path for symlinks
    // before declaring an empty pre-seed store, and fail closed otherwise.
    try {
      fs.lstatSync(canonicalSnapshot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const probe = probeSnapshotAbsence(this.canonicalRoot, MES_SNAPSHOT_REL);
        if (!probe.absent) {
          if (probe.symlinkAt !== undefined) {
            storeFail(
              'escape',
              `MES snapshot path "${MES_SNAPSHOT_REL}" contains a symlink at "${probe.symlinkAt}" — a symlinked snapshot is never a missing pre-seed store`,
            );
          }
          storeFail('unreadable', `cannot confirm MES snapshot absence: ${probe.reason ?? 'unknown'}`);
        }
        return [];
      }
      storeFail('unreadable', `cannot stat MES snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }


    let raw: string;
    try {
      raw = readRootBoundFile(this.canonicalRoot, MES_SNAPSHOT_REL).content;
    } catch (err) {
      const pe = err as PathReadError;
      const reason = pe && typeof pe === 'object' && 'code' in pe ? String(pe.code) : 'unreadable';
      const mapped: MesSnapshotStoreErrorCode =
        reason === 'escape' || reason === 'not-regular-file' || reason === 'toctou-change'
          ? 'escape'
          : 'unreadable';
      storeFail(mapped, `cannot read MES snapshot (${reason}): ${err instanceof Error ? err.message : String(err)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      storeFail('corrupt-snapshot', `MES snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      storeFail('corrupt-snapshot', 'MES snapshot must be a JSON object container');
    }

    // Closed container envelope (CV S01-STAGE-REVIEW-F001): unknown top-level
    // fields must never pass through — an injected key could otherwise carry
    // out-of-band payload alongside validated facts.
    for (const key of Object.keys(obj)) {
      if (key !== 'schema_version' && key !== 'facts') {
        storeFail('corrupt-snapshot', `MES snapshot container has unknown top-level field "${key}"`);
      }
    }
    if (obj.schema_version !== MES_SCHEMA_VERSION) {
      storeFail(
        'corrupt-snapshot',
        `MES snapshot schema_version must be ${MES_SCHEMA_VERSION}, got ${JSON.stringify(obj.schema_version)}`,
      );
    }
    if (!Array.isArray(obj.facts)) {
      storeFail('corrupt-snapshot', 'MES snapshot "facts" must be an array');
    }

    return (obj.facts as unknown[]).map((fact, index) => {
      try {
        return validateMesFactEnvelope(fact);
      } catch (err) {
        const detail =
          err instanceof SchemaValidationError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        storeFail('corrupt-snapshot', `MES snapshot fact[${index}] is invalid: ${detail}`);
      }
    });
  }
}

/** Convenience factory for a root-bound snapshot store. */
export function createMesSnapshotStore(root: string): MesSnapshotStore {
  return new MesSnapshotStore(root);
}
