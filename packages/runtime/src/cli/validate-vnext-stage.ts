/**
 * Explicit vNext mechanical Stage validator.
 *
 *   node packages/runtime/dist/cli/validate-vnext-stage.js \
 *     <tasks.md> <manifest.json> <evidence-dir> [project-root]
 *
 * The tasks file is read only to bind and audit the source path.  No goal,
 * task, proof, command, or acceptance fact is inferred from its Markdown body.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  VNEXT_SCHEMA_VERSION,
  validateReceipt,
  verifyReceiptChain,
  verifyReceiptDigest,
  type VNextManifest,
} from '@proofloop/kernel';
import {
  validateDependencyBinding,
  type VNextDependencyBinding,
} from '@proofloop/kernel/dist/vnext';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { integrationReceiptDir } from '../receipt-layout';
import {
  isIntegratedSliceCurrent,
  type IntegrationReceiptRef,
} from '../vnext/binding-currentness';
import {
  readRootBoundFile,
  resolveProjectRoot,
  errorMessage,
  validateVNextManifestArtifact,
  vnextError,
  computeVNextManifestDigest,
  isRecord,
  type VNextCliError,
} from './vnext-cli-support-vnext';
import {
  assertSliceLocalCredentialBindingFields,
  computeSliceLocalCredentialExpectation,
  credentialSchemaVersionMismatch,
} from '../vnext/cv-validation';
// S13-S17 remediation Phase 4 (§9.6): the mechanical Stage Composition
// Closure Audit helper — SPV calls this validator; it never reasons about
// expected consumers from natural language.
import { auditVNextStageComposition } from '../vnext/stage-composition-audit';
export interface ValidateVNextStageResult {
  readonly valid: boolean;
  readonly stage_id: string;
  readonly schema_version: typeof VNEXT_SCHEMA_VERSION;
  readonly errors: readonly VNextCliError[];
}

function invalid(
  stageId: string,
  errors: readonly VNextCliError[],
): ValidateVNextStageResult {
  return {
    valid: false,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    errors,
  };
}

/**
 * Run the vNext mechanical gate.  This function is read-only and returns a
 * bounded result for every expected filesystem/schema failure.
 */
export function validateVNextStage(
  tasksPath: string,
  manifestPath: string,
  evidenceDir?: string,
  projectRoot?: string,
): ValidateVNextStageResult {
  let root: string;
  try {
    root = resolveProjectRoot(projectRoot);
  } catch (error) {
    return invalid('unknown', [vnextError('ROOT_ERROR', errorMessage(error))]);
  }

  try {
    // The body is deliberately discarded.  readRootBoundFile performs the
    // no-follow, regular-file, UTF-8 and post-read TOCTOU checks required for
    // the source binding, without invoking any Markdown parser.
    readRootBoundFile(root, tasksPath);
  } catch (error) {
    return invalid('unknown', [
      vnextError('TASKS_READ_FAILED', `tasks.md cannot be read as a root-bound source: ${errorMessage(error)}`, {
        path: tasksPath,
      }),
    ]);
  }

  let manifestValue: unknown;
  try {
    const read = readRootBoundFile(root, manifestPath);
    try {
      manifestValue = JSON.parse(read.content) as unknown;
    } catch (error) {
      return invalid('unknown', [
        vnextError('MANIFEST_JSON_INVALID', `manifest is not valid JSON: ${errorMessage(error)}`, {
          path: manifestPath,
        }),
      ]);
    }
  } catch (error) {
    return invalid('unknown', [
      vnextError('MANIFEST_READ_FAILED', `manifest cannot be read as a root-bound file: ${errorMessage(error)}`, {
        path: manifestPath,
      }),
    ]);
  }

  const checked = validateVNextManifestArtifact(root, manifestValue, {
    tasksPath,
    evidenceDir,
    verifyReferenceDigests: true,
    // S09-D-T01 — final all-binding Validator: every declared Evidence file
    // must bind exactly to this Manifest and no unrecovered refresh journal
    // may be present.  Mixed bindings fail closed before SPV/admission.
    verifyEvidenceBindings: true,
  });
  let errors = checked.errors;
  if (checked.manifest !== null) {
    // S12-D-T03 — FR-023: in slice-local mode the evidence binding of an
    // INTEGRATED CURRENT slice is a historical fact that stays valid across
    // a replan (Plan Digest / Manifest Digest headers).  The exemption is
    // evaluated lazily, only when an exemptable binding mismatch exists:
    // legacy manifests (no `binding`) and all-green stages never touch the
    // receipt chain (zero behavior change / zero extra I/O).  An integration
    // chain that cannot be evaluated fails closed with an explicit error and
    // no slice is exempted.
    const hasExemptableMismatch = errors.some(
      (error) =>
        error.type === 'EVIDENCE_BINDING_MISMATCH' &&
        error.message.startsWith(EVIDENCE_BINDING_MISMATCH_MESSAGE_PREFIX),
    );
    if (hasExemptableMismatch) {
      try {
        const exemptSliceIds = computeEvidenceExemptSliceIds(
          root,
          checked.manifest,
          computeVNextManifestDigest(checked.manifest),
        );
        errors = filterExemptedEvidenceBindingMismatches(errors, exemptSliceIds);
      } catch (error) {
        errors = [
          ...errors,
          vnextError(
            'EVIDENCE_EXEMPTION_FAILED',
            `slice-local evidence exemption could not be evaluated; evidence binding checks stay strict: ${errorMessage(error)}`,
          ),
        ];
      }
    }
    // S13-S17 remediation Phase 4 (§9.2–§9.6) — Stage Composition Closure
    // Audit: mechanically derive the expected public execution chain from
    // this Manifest composition and fail closed on any behavior/version/
    // count/tip/public-route gap before SPV or admission can see PLAN_READY.
    const composition = auditVNextStageComposition(checked.manifest);
    for (const gap of composition.findings) {
      errors = [
        ...errors,
        vnextError(
          'STAGE_COMPOSITION_GAP',
          `${gap.missing_step}: ${gap.reason}`,
          {
            ...(gap.slice_id !== undefined ? { slice_id: gap.slice_id } : {}),
            stage_composition: gap,
          },
        ),
      ];
    }
  }
  return {
    valid: errors.length === 0,
    stage_id: checked.stage_id,
    schema_version: VNEXT_SCHEMA_VERSION,
    errors,
  };
}

export function validateVNextStageCli(argv: readonly string[]): number {
  const [tasksPath, manifestPath, evidenceDir, projectRoot, ...extra] = argv;
  if (!tasksPath || !manifestPath || !evidenceDir || extra.length > 0) {
    const result = invalid('unknown', [
      vnextError(
        'USAGE',
        'Usage: node dist/cli/validate-vnext-stage.js <tasks.md> <manifest.json> <evidence-dir> [project-root]',
      ),
    ]);
    console.log(JSON.stringify(result));
    return 1;
  }

  const result = validateVNextStage(tasksPath, manifestPath, evidenceDir, projectRoot);
  console.log(JSON.stringify(result));
  return result.valid ? 0 : 1;
}

// ============================================================
// FR-023 — slice-local evidence binding exemption (S12-D-T03)
// ============================================================

/** One entry of the persisted INTEGRATION_PASS chain, with its receipt-bound dependency facts. */
interface VNextSliceLocalChainEntry {
  readonly ref: IntegrationReceiptRef;
  readonly dependencyBindings: readonly VNextDependencyBinding[];
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;

function receiptFactDigest(value: unknown, label: string, length: 40 | 64): string {
  const pattern = length === 64 ? SHA256_HEX_RE : GIT_SHA_RE;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is not a valid ${length === 40 ? 'Git' : 'SHA-256'} digest`);
  }
  return value;
}

/**
 * Read the current INTEGRATION_PASS receipt chain of every Slice (slice-local
 * mode only, §8.7).  Each persisted receipt must carry the receipt-bound
 * stage/slice contract digests and the merged canonical HEAD (`commit_sha`)
 * the slice-level currentness criterion consumes; a legacy/v2 Integration
 * Receipt without the binding fields can never back a slice-local
 * currentness claim and fails closed (never guessed around).  A malformed
 * chain entry aborts the whole evaluation: currentness is a chain-wide
 * property and must never be computed over partial facts.
 *
 * S12-D-T03 (§8.3) + T04b (user authorization): the payload schema_version
 * is discriminated FIRST through the shared credential helper — v2 receipts
 * carrying binding fields are illegal credentials in a slice-local Stage
 * (BINDING.MODE_MIXED), a schema_version 3 receipt IS the legal slice-local
 * credential (its three binding fields are validated against the Manifest
 * contract digests and the recomputed execution binding through the shared
 * cv-validation helpers), and unknown future versions (>3) fail closed
 * explicitly (BINDING.SCHEMA_FUTURE). A rejected chain aborts the whole
 * exemption evaluation (all-or-nothing, never partial currentness facts).
 */
function readVNextIntegrationReceiptChain(
  root: string,
  manifest: VNextManifest,
): VNextSliceLocalChainEntry[] {
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
      throw new Error(
        `vNext Integration Receipt chain is invalid for ${manifest.stage_id}/${slice.slice_id}`,
      );
    }
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
          throw new Error(
            `Receipt ${name} is not an INTEGRATION_PASS fact in the integration category`,
          );
        }
        if (!verifyReceiptDigest(file)) {
          throw new Error(`Receipt ${name} has an invalid digest`);
        }
        if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
          throw new Error('vNext Integration Receipt stage/slice binding is invalid');
        }
        const payload = receipt.payload;
        if (!isRecord(payload)) {
          throw new Error('INTEGRATION_PASS payload must be a JSON object');
        }
        // S12-D-T03 (§8.3) + T04b (user authorization): explicit credential
        // schema_version discrimination runs BEFORE the binding-field reads —
        // a v2 receipt carrying binding fields is an illegal credential in a
        // slice-local Stage (BINDING.MODE_MIXED), a slice-local (3) receipt
        // IS the legal credential of a slice-local Stage (S12-D REPLAN), and
        // an unknown future version (>3) fails closed explicitly. Same
        // semantics as the shared credentialSchemaVersionMismatch helper; a
        // rejected chain aborts the whole exemption evaluation (all-or-
        // nothing, never partial currentness facts).
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
        const stageContractDigest = receiptFactDigest(
          payload.stage_contract_digest,
          'INTEGRATION_PASS.stage_contract_digest',
          64,
        );
        const sliceContractDigest = receiptFactDigest(
          payload.slice_contract_digest,
          'INTEGRATION_PASS.slice_contract_digest',
          64,
        );
        const integrationHead = receiptFactDigest(
          payload.commit_sha,
          'INTEGRATION_PASS.commit_sha',
          40,
        );
        // §8.2 dependency_bindings (Phase 1 serial execution: empty or a
        // single dependency).  Kernel closed validator, fail-closed shape.
        // S12-D repair (v3 consumer chain, read-side fail-closed): a v3
        // INTEGRATION_PASS credential MUST carry the field — the write side
        // always persists it (an empty array for a no-dependency slice), so
        // a missing or non-array value is an explicit rejection, never a
        // silent empty-list recompute (an empty-list recompute would
        // wrongly exempt a dependency slice whose persisted binding facts
        // were dropped, and would diverge from the write-side gate).
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
        // T04b (user authorization): in slice-local mode the v3 credential's
        // three binding fields are validated through the SHARED cv-validation
        // helpers (imported, never copied) — 64-hex shape, exact match with
        // the Manifest stage/slice contract digests and the recomputed
        // execution binding (kernel bindings.ts oracle over the
        // receipt-bound dependency bindings and the credential's own base
        // snapshot). A v3 credential that is not self-consistent fails
        // closed here, before it can back a currentness claim. The schema
        // discrimination above already rejected v2-in-slice-local
        // (MODE_MIXED) and unknown future versions (SCHEMA_FUTURE).
        assertSliceLocalCredentialBindingFields(
          payload,
          'INTEGRATION_PASS.payload',
          manifest.binding !== undefined
            ? computeSliceLocalCredentialExpectation(
                manifest,
                slice.slice_id,
                dependencyBindings,
                payload,
              )
            : undefined,
        );
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
 * FR-023 — the set of Slice ids that are INTEGRATED and CURRENT in
 * slice-local mode (§8.5/§10.5): an integrated slice whose stage/slice
 * contract, dependency bindings and integration receipt chain are current
 * stays valid across a replan, so its historical evidence binding (bound to
 * a previous whole-plan digest) is legal history.
 *
 * Legacy manifests (no `binding`) return the empty set: the legacy path
 * stays strict and untouched (zero behavior change, zero receipt I/O).
 * Un-integrated slices are never exempted (§8.5: no auto carry-forward
 * across Plan revisions).  A slice whose currentness cannot be evaluated
 * fails closed through the typed kernel oracle errors.
 */
function computeEvidenceExemptSliceIds(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
): ReadonlySet<string> {
  const exempt = new Set<string>();
  if (manifest.binding === undefined) return exempt;
  const chain = readVNextIntegrationReceiptChain(root, manifest);
  if (chain.length === 0) return exempt;
  const bySlice = new Map(chain.map((entry) => [entry.ref.slice_id, entry] as const));
  const receiptChain = chain.map((entry) => entry.ref);
  for (const slice of manifest.slices) {
    const entry = bySlice.get(slice.slice_id);
    if (entry === undefined) continue; // un-integrated: strict checks stay
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
      exempt.add(slice.slice_id);
    }
  }
  return exempt;
}

/** The binding-value mismatch variant emitted by the shared evidence checker. */
const EVIDENCE_BINDING_MISMATCH_MESSAGE_PREFIX = 'evidence binding does not match the Manifest';

/**
 * FR-023 — drop only the binding-value mismatch of exempt slices.
 *
 * The exemption is deliberately narrow: an admitted CURRENT slice's
 * historical Plan Digest / Manifest Digest binding is waived, but unreadable
 * evidence, missing/unparseable Plan Binding headers, unrecovered refresh
 * journals and every other failure mode stay fail-closed (tampering is
 * never silently blessed by a currentness claim).
 */
function filterExemptedEvidenceBindingMismatches(
  errors: readonly VNextCliError[],
  exemptSliceIds: ReadonlySet<string>,
): readonly VNextCliError[] {
  if (exemptSliceIds.size === 0) return errors;
  return errors.filter((error) => {
    if (
      error.type === 'EVIDENCE_BINDING_MISMATCH' &&
      error.slice_id !== undefined &&
      exemptSliceIds.has(error.slice_id) &&
      error.message.startsWith(EVIDENCE_BINDING_MISMATCH_MESSAGE_PREFIX)
    ) {
      return false;
    }
    return true;
  });
}

if (require.main === module) {
  process.exitCode = validateVNextStageCli(process.argv.slice(2));
}
