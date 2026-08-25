/** vNext Integration producer; canonical readers live in integration-validation.ts. */
/**
 * vNext Integration admission.
 *
 * Integration is a downstream vNext consumer, not a legacy reducer action. It
 * revalidates the complete persisted Worker → CV → Slice Commit prefix, the
 * current Git boundary, and the active Manifest/Plan/snapshot tuple before it
 * delegates the single Receipt write to `runReceiptAdmission`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  computeReceiptDigest,
  validateReceipt,
} from '@proofloop/kernel';
// S12-D repair (v3 consumer chain): the kernel closed dependency-binding
// validator is applied to the persisted INTEGRATION_PASS
// `dependency_bindings` facts (same closed validator `next` / `validate`
// apply to the read side).
import { validateDependencyBinding } from '@proofloop/kernel/dist/vnext';
import type {
  Receipt,
  VNextExecutionScope,
  VNextManifest,
  VNextManifestSlice,
} from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from './stage-id';
import { readGitHead, resolveGitRoot } from '../git-source';
import { detectPlanManifestRoute } from './manifest-route';
import {
  committerReceiptDir,
  cvReceiptDir,
  integrationReceiptDir,
  tasksReceiptDir,
} from '../receipt-layout';
import type {
  AdmitResult,
  ReceiptBuild,
  ReceiptWriterPort,
} from '../admit-pipeline';
import { runReceiptAdmission } from '../admit-pipeline';
import type { IntegrationAdmissionRequest } from '../admission-request';
import { validateVNextCvResultEnvelope } from './cv-result-envelope';
import {
  assertSliceLocalCredentialBindingFields,
  assertUpstreamTaskCompleteSemantics,
  credentialSchemaVersionMismatch,
} from './cv-validation';
import type { VNextSliceLocalBindingExpectation } from './cv-validation';
// S12-D-T04 (S12-D REPLAN): the slice-local binding expectation (stage/slice
// contract digests + recomputed execution binding) is the single shared
// computation of the Worker/CV/Commit/Integration credential consumers.
import {
  computeSliceLocalBindingExpectation,
  readSliceLocalDependencyBindings,
} from './dispatch';
import { loadAncestorReplanDispositionRecords, readCurrentEpoch } from './replan-epoch';
import { isVNextHistoricalInvalidatedCommitPayload, isVNextHistoricalInvalidatedCvPayload, isVNextHistoricalInvalidatedIntegrationPayload } from './finalize-lineage';
import {
  assertVNextManifestReferenceBindings,
  readVNextManifest,
} from './dispatch';
import {
  VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
  VNEXT_INTEGRATION_ACTION,
  VNEXT_INTEGRATION_RESULT_TYPE,
  VNEXT_INTEGRATION_SCHEMA_VERSION,
  VNEXT_SLICE_COMMIT_ACTION,
  VNEXT_SLICE_COMMIT_RESULT_TYPE,
} from './types';
import type {
  VNextAdmissionAuthority,
  VNextCvResultEnvelope,
  VNextIntegrationAdmissionState,
} from './types';

import {
  REQUEST_FIELDS,
  VNextIntegrationAdmissionError,
  assertCommittedChangedFiles,
  assertExactFields,
  assertVNextManifestRoute,
  canonicalProjectRoot,
  fail,
  readReceiptChain,
  requireCanonicalStageId,
  requireGitSha,
  requireIdentifier,
  requireRecord,
  sameValue,
  sliceBinding,
  validateCvFacts,
  validateIntegrationPayload,
  validateSliceCommitPayload,
  validateWorkerFacts,
} from './integration-validation';
import type {
  CvFacts,
  IntegrationAdmissionCode,
  IntegrationFactsValidationOptions,
  SliceBinding,
  TupleBinding,
  ValidatedIntegrationFacts,
  WorkerFacts,
} from './integration-validation';
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFacts(
  request: IntegrationAdmissionRequest,
  dependencies: VNextIntegrationAdmissionDependencies,
  options: IntegrationFactsValidationOptions = {},
): ValidatedIntegrationFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${request.stageId}.json`);
  assertVNextManifestRoute(root, manifestPath, request.stageId);

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Integration requires a valid explicit vNext Manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.version !== 2 || manifest.plan.schema_version !== 2 || manifest.stage_id !== request.stageId) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Integration accepts only the current vNext schema-v2 Manifest');
  }
  const manifestDigest = computeDigest(manifest);
  try {
    assertVNextManifestReferenceBindings(root, manifest);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Manifest/Plan reference binding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let authority: VNextAdmissionAuthority;
  try {
    const currentEpoch = readCurrentEpoch(root, request.stageId);
    authority = { stagePlan: currentEpoch.stagePlan, spv: currentEpoch.spv };
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Stage Plan/SPV authority is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const snapshotDigest = authority.spv.snapshot_digest;
  const slice = sliceBinding(root, manifest, request.sliceId);
  const tuple: TupleBinding = {
    stageId: request.stageId,
    sliceId: request.sliceId,
    manifestDigest,
    planDigest: manifest.plan.plan_digest,
    proofIndexDigest: slice.proofIndexDigest,
    snapshotDigest,
  };
  for (const fact of [authority.stagePlan, authority.spv]) {
    if (
      fact.stage_id !== tuple.stageId ||
      fact.manifest_digest !== tuple.manifestDigest ||
      fact.plan_digest !== tuple.planDigest ||
      fact.snapshot_digest !== tuple.snapshotDigest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan/SPV authority is stale or not bound to the current Manifest/Plan/snapshot');
    }
  }
  if (authority.stagePlan.spv_receipt_digest !== authority.spv.digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan authority is not bound to the fresh SPV_PASS fact');
  }

  // S12-D-T04 (S12-D REPLAN): slice-local mode — every credential of the
  // Slice (Worker chain, CV chain, SLICE_COMMIT, INTEGRATION_PASS) must bind
  // the SAME Manifest contract digests and the recomputed execution binding.
  // The base snapshot is the admitted SPV snapshot (the Stage's canonical
  // integration HEAD at admission), stable for the whole Stage.
  const sliceLocalBinding =
    manifest.binding !== undefined
      ? computeSliceLocalBindingExpectation(
          root,
          manifest,
          request.sliceId,
          authority.spv.snapshot_digest,
        )
      : undefined;
  const worker = validateWorkerFacts(root, manifest, slice, tuple, sliceLocalBinding);
  const cv = validateCvFacts(root, slice, manifest.binding !== undefined, tuple, worker, sliceLocalBinding, undefined, false, manifest);
  if (cv.final.worker_receipt_digest !== worker.tipDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'latest CV_PASS is not bound to the current complete Worker Receipt chain');
  }

  const committerChain = readReceiptChain(
    root,
    committerReceiptDir(root, request.stageId, request.sliceId),
    'vNext Slice Commit Receipt chain',
  );
  const replanDispositions = loadAncestorReplanDispositionRecords(root, request.stageId);
  const allWorkerReceipts = readReceiptChain(root, tasksReceiptDir(root, request.stageId, request.sliceId), 'vNext Worker Receipt chain').receipts;
  const allCvReceipts = readReceiptChain(root, cvReceiptDir(root, request.stageId, request.sliceId), 'vNext CV Receipt chain', true).receipts;
  const activeCommitReceipts = committerChain.receipts.filter((receipt) => {
    if (!isRecord(receipt.payload)) return false;
    if (!isVNextHistoricalInvalidatedCommitPayload(receipt.payload, request.stageId, request.sliceId, slice.tasks.map((task) => task.taskId), replanDispositions)) return true;
    const cvDigest = receipt.payload.cv_receipt_digest;
    const historicalCv = allCvReceipts.find((candidate) => candidate.digest === cvDigest);
    if (historicalCv === undefined || !isRecord(historicalCv.payload)) return true;
    return !isVNextHistoricalInvalidatedCvPayload(historicalCv.payload, request.stageId, slice.tasks.map((task) => task.taskId), allWorkerReceipts, worker.receipts, replanDispositions);
  });
  if (activeCommitReceipts.length !== 1 || committerChain.tipDigest === null) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      'Integration requires exactly one previously admitted vNext SLICE_COMMIT Receipt for this Slice',
    );
  }
  const sliceCommitReceipt = activeCommitReceipts[0];
  if (sliceCommitReceipt === undefined) {
    fail('DOMAIN.INVALID_TRANSITION', 'vNext Slice Commit Receipt is missing');
  }
  const changedFiles = assertCommittedChangedFiles(root, manifest, tuple, request.commitSha, slice, worker, cv);
  validateSliceCommitPayload(
    root,
    manifest,
    sliceCommitReceipt,
    tuple,
    manifest.binding !== undefined,
    slice,
    worker,
    cv,
    request.commitSha,
    changedFiles,
    sliceLocalBinding,
  );

  const integrationChain = readReceiptChain(
    root,
    integrationReceiptDir(root, request.stageId, request.sliceId),
    'vNext Integration Receipt chain',
  );
  const activeIntegrationReceipts = integrationChain.receipts.filter((receipt) => {
    if (!isRecord(receipt.payload)) return true;
    return !isVNextHistoricalInvalidatedIntegrationPayload(receipt.payload, request.stageId, request.sliceId, slice.tasks.map((task) => task.taskId), replanDispositions);
  });
  if (!options.allowInstalledIntegrationReceipt && activeIntegrationReceipts.length > 0) {
    for (const [index, receipt] of activeIntegrationReceipts.entries()) {
      if (
        receipt.version !== 1 ||
        receipt.type !== 'INTEGRATION_PASS' ||
        receipt.stage_id !== request.stageId ||
        receipt.slice_id !== request.sliceId
      ) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Integration Receipt ${index} is legacy, mixed, or bound to the wrong tuple`);
      }
      validateIntegrationPayload(requireRecord(receipt.payload, `INTEGRATION_PASS[${index}].payload`), `INTEGRATION_PASS[${index}].payload`, root, manifest.binding !== undefined, sliceLocalBinding);
    }
    fail('DOMAIN.INVALID_TRANSITION', 'a vNext Integration Receipt already exists for this Slice');
  }

  return {
    root,
    manifest,
    slice,
    tuple,
    authority,
    worker,
    cv,
    sliceCommitReceipt,
    sliceCommitReceiptDigest: sliceCommitReceipt.digest,
    commitSha: request.commitSha,
    changedFiles,
  };
}

function assertIntegrationFactsUnchanged(
  expected: ValidatedIntegrationFacts,
  current: ValidatedIntegrationFacts,
): void {
  if (
    !sameValue(current.manifest, expected.manifest) ||
    !sameValue(current.authority, expected.authority) ||
    !sameValue(current.sliceCommitReceipt, expected.sliceCommitReceipt) ||
    !sameValue(integrationState(current), integrationState(expected))
  ) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      'vNext Integration Manifest, Plan/snapshot, predecessor Receipt tips, commit boundary, or changed-files facts changed after validation',
    );
  }
}

function assertInstalledIntegrationReceipt(
  facts: ValidatedIntegrationFacts,
  writeResult: { readonly path: string; readonly digest: string },
): void {
  const directory = integrationReceiptDir(
    facts.root,
    facts.tuple.stageId,
    facts.tuple.sliceId,
  );
  const expectedPath = path.join(directory, `${writeResult.digest}.json`);
  if (writeResult.path !== expectedPath) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'vNext Integration writer result is not the canonical installed Receipt for this Slice',
    );
  }

  const chain = readReceiptChain(
    facts.root,
    directory,
    'vNext Integration Receipt chain after install',
  );
  const replanDispositions = loadAncestorReplanDispositionRecords(facts.root, facts.tuple.stageId);
  const activeReceipts = chain.receipts.filter((candidate) => {
    if (!isRecord(candidate.payload)) return true;
    return !isVNextHistoricalInvalidatedIntegrationPayload(candidate.payload, facts.tuple.stageId, facts.tuple.sliceId, facts.slice.tasks.map((task) => task.taskId), replanDispositions);
  });
  const receipt = chain.receipts.find((candidate) => candidate.digest === writeResult.digest);
  if (activeReceipts.length !== 1 || receipt === undefined || activeReceipts[0]?.digest !== writeResult.digest) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      'vNext Integration Receipt chain changed during install; the installed Receipt is not the sole current Integration fact',
    );
  }
  validateIntegrationPayload(
    requireRecord(receipt.payload, 'INTEGRATION_PASS.afterInstall.payload'),
    'INTEGRATION_PASS.afterInstall.payload',
    facts.root,
    facts.manifest.binding !== undefined,
    // S12-D-T04 (S12-D REPLAN): the installed slice-local INTEGRATION_PASS
    // must bind the same Manifest contract digests and recomputed execution
    // binding as every other credential of the Slice.
    facts.manifest.binding !== undefined
      ? computeSliceLocalBindingExpectation(
          facts.root,
          facts.manifest,
          facts.tuple.sliceId,
          facts.authority.spv.snapshot_digest,
        )
      : undefined,
  );
  if (!sameValue(receipt.payload, integrationPayload(facts))) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'installed Integration Receipt payload does not match validated facts');
  }
}

function validateRequest(value: unknown): IntegrationAdmissionRequest {
  const request = requireRecord(value, 'vNext Integration request');
  assertExactFields(request, REQUEST_FIELDS, 'vNext Integration request');
  if (request.type !== 'integration') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Integration request type must be integration');
  }
  requireCanonicalStageId(request.stageId, 'integration.stageId');
  requireIdentifier(request.sliceId, 'integration.sliceId');
  requireGitSha(request.commitSha, 'integration.commitSha');
  return request as unknown as IntegrationAdmissionRequest;
}

function integrationState(facts: ValidatedIntegrationFacts): VNextIntegrationAdmissionState {
  return {
    schema_version: VNEXT_INTEGRATION_SCHEMA_VERSION,
    type: VNEXT_INTEGRATION_RESULT_TYPE,
    action: VNEXT_INTEGRATION_ACTION,
    stage_id: facts.tuple.stageId,
    slice_id: facts.tuple.sliceId,
    manifest_digest: facts.tuple.manifestDigest,
    plan_digest: facts.tuple.planDigest,
    proof_index_digest: facts.tuple.proofIndexDigest,
    snapshot_digest: facts.tuple.snapshotDigest,
    commit_sha: facts.commitSha,
    slice_commit_receipt_digest: facts.sliceCommitReceiptDigest,
    worker_receipt_digest: facts.worker.tipDigest,
    cv_receipt_digest: facts.cv.tipDigest,
    changed_files: [...facts.changedFiles],
    receipt_chain_valid: true,
  };
}

/**
 * S12-D-T04 (S12-D REPLAN): the persisted INTEGRATION_PASS credential
 * payload. The credential schema_version follows the Stage credential mode:
 * legacy Manifest (no binding) → v2 (identical to `integrationState`, zero
 * behavior change); slice-local Manifest → v3 carrying the three binding
 * fields (stage/slice contract digests from the Manifest and the recomputed
 * execution binding through the kernel oracle). The admission STATE stays on
 * the v2 state schema (the writer-seam state discriminator); the Receipt
 * payload is the credential.
 */
function integrationPayload(facts: ValidatedIntegrationFacts): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...integrationState(facts) };
  if (facts.manifest.binding !== undefined) {
    const sliceLocalBinding = computeSliceLocalBindingExpectation(
      facts.root,
      facts.manifest,
      facts.tuple.sliceId,
      facts.authority.spv.snapshot_digest,
    );
    payload.schema_version = VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL;
    payload.stage_contract_digest = sliceLocalBinding.stageContractDigest;
    payload.slice_contract_digest = sliceLocalBinding.sliceContractDigest;
    payload.execution_binding_digest = sliceLocalBinding.executionBindingDigest;
    // S12-D repair (v3 consumer chain): the v3 INTEGRATION_PASS credential
    // persists the receipt-bound dependency binding facts (§8.2) it was
    // admitted against — the SAME facts the execution binding was computed
    // from (`computeSliceLocalBindingExpectation` reads them through
    // `readSliceLocalDependencyBindings`). The read-side consumers
    // (`next` / `validate-vnext-stage`) recompute the execution binding
    // from these persisted facts; without them a Slice with declared
    // dependencies would be recomputed against an empty dependency list and
    // a valid dependency-backed credential would be rejected.
    payload.dependency_bindings = readSliceLocalDependencyBindings(
      facts.root,
      facts.manifest,
      facts.tuple.sliceId,
    );
  }
  return payload;
}

function integrationReceiptBuild(facts: ValidatedIntegrationFacts): ReceiptBuild {
  return {
    type: 'INTEGRATION_PASS',
    stage_id: facts.tuple.stageId,
    slice_id: facts.tuple.sliceId,
    timestamp: new Date().toISOString(),
    payload: integrationPayload(facts),
  };
}

function rejectedIntegration(
  message: string,
  code: IntegrationAdmissionCode = 'RUNTIME.SCHEMA_MISMATCH',
): AdmitResult<VNextIntegrationAdmissionState> {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code, severity: 'error', message }],
  };
}

export interface VNextIntegrationAdmissionDependencies {
  readonly projectRoot: string;
  readonly writer?: ReceiptWriterPort;
}

/** Validate the closed request shape used by the Runtime/Host integration seam. */
export function validateVNextIntegrationRequest(value: unknown): IntegrationAdmissionRequest {
  try {
    return validateRequest(value);
  } catch (error) {
    throw new Error(
      `vNext Integration request schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Admit one vNext Integration fact without entering legacy reconcile/reducer
 * code. The only persistence operation is the shared bounded Receipt seam.
 */
export function admitVNextIntegration(
  value: unknown,
  dependencies: VNextIntegrationAdmissionDependencies,
): AdmitResult<VNextIntegrationAdmissionState> {
  let request: IntegrationAdmissionRequest;
  try {
    request = validateRequest(value);
  } catch (error) {
    const code = error instanceof VNextIntegrationAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedIntegration(
      `vNext Integration request rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  let facts: ValidatedIntegrationFacts;
  try {
    facts = validateFacts(request, dependencies);
  } catch (error) {
    const code = error instanceof VNextIntegrationAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedIntegration(
      `vNext Integration admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  const state = integrationState(facts);
  return runReceiptAdmission<VNextIntegrationAdmissionState>({
    build: integrationReceiptBuild(facts),
    targetDir: integrationReceiptDir(facts.root, request.stageId, request.sliceId),
    nextState: state,
    writer: dependencies.writer,
    projectRoot: facts.root,
    admissionKey: `vnext-integration:${request.stageId}:${request.sliceId}:${request.commitSha}`,
    beforeWrite: () => {
      assertVNextManifestRoute(
        facts.root,
        path.join(facts.root, '.proofloop', 'manifests', `${request.stageId}.json`),
        request.stageId,
      );
      const current = validateFacts(request, dependencies);
      assertIntegrationFactsUnchanged(facts, current);
    },
    afterWrite: (writeResult) => {
      assertVNextManifestRoute(
        facts.root,
        path.join(facts.root, '.proofloop', 'manifests', `${request.stageId}.json`),
        request.stageId,
      );
      const current = validateFacts(request, dependencies, {
        allowInstalledIntegrationReceipt: true,
      });
      assertIntegrationFactsUnchanged(facts, current);
      assertInstalledIntegrationReceipt(facts, writeResult);
    },
  });
}

export const admitVNextIntegrationResult = admitVNextIntegration;
