/**
 * S13-S17 remediation Phase 4 — Stage Composition Closure Audit (§9).
 *
 * Read-only, mechanical derivation of the expected public execution chain
 * from a compiled vNext Manifest composition:
 *
 *   Manifest Task → Worker admission → finalize-slice → CV → Slice Commit
 *   → Integration  …(all Integrations)→ Gate → Review → Close
 *
 * For every node the audit proves the §9.3 fields (producer, public_operation,
 * consumer, accepted_binding_mode, accepted_schema, required_predecessor,
 * required_binding, restart_reader) and covers the §9.4 closures:
 *
 *   - 行为闭环 (behavior): every expected action has a live downstream
 *     consumer AND a closed dispatcher/consumer wiring entry; declared
 *     dependencies must resolve (prior-Stage grammar) and stay acyclic; the
 *     Stage tail is derived from the DECLARED Slices, never a constant chain.
 *   - 版本闭环 (version): accepted schemas are bound to the REAL admission
 *     contract constants of every producer/consumer pair and cross-checked
 *     through the shared `credentialSchemaVersionMismatch` discriminator.
 *   - 数量闭环 (count): N Manifest Tasks + exactly 1 finalize per Slice —
 *     task anchors resolve uniquely, Slice ids are unique, unknown or cyclic
 *     dependencies fail closed.
 *   - Tip 闭环 (tip): task coverage tip / finalize tip / CV tip / commit tip /
 *     integration tip are derived per Slice and must be satisfiable.
 *   - Public route 闭环: every step routes through the closed public CLI
 *     registry (`proofloop <domain> <operation>`), never an internal-only seam.
 *
 * A gap yields a §9.5 finding (`result: PLAN_DEFECT`, `route_code: PLAN_GAP`,
 * `subtype: STAGE_COMPOSITION_GAP`) — never PLAN_READY.  The audit consumes no
 * Receipt/Evidence/Context state and performs no writes: it is callable by SPV
 * and enforced by Stage Plan admission before any authority write.
 */

import type { VNextManifest, VNextManifestSlice } from '@proofloop/kernel';
import { DOMAIN_REGISTRY } from '../cli/proofloop-common';
// Single acyclic route fact source shared with the top-level proofloopCli
// wiring tests (CV repair R2 #2) — data only, no dispatcher imports.
import { VNEXT_ROUTE_TABLE } from '../cli/vnext-route-table';
// NOTE on wiring: this module must NOT import the public domain dispatchers
// (cli/proofloop-stage|review|gate|plan).  Stage Plan admission (vnext/
// admission.ts) enforces this audit from inside the next.ts dependency graph,
// so a dispatcher import here would close the load cycle
// next -> admission -> audit -> dispatcher -> next and break module
// initialisation.  Route wiring is instead proven BEHAVIOURALLY by the
// public-route smoke matrix (real argv entries reaching each closed handler)
// in stage-composition-audit.spec.ts.
import {
  committerReceiptDir,
  cvReceiptDir,
  integrationReceiptDir,
  reviewReceiptDir,
  stageGateReceiptDir,
  tasksReceiptDir,
} from '../receipt-layout';
// Behavior-closure liveness proof: the admission/dispatch seams are imported
// and type-checked at audit time so a deleted or stubbed consumer fails the
// chain instead of silently passing composition validation.
import { projectVNextWorkerDispatch } from './dispatch';
import { admitVNextWorkerResult } from './worker-admission';
import { admitVNextCVResult } from './cv-admission';
import { admitVNextSliceCommit } from './commit-admission';
import { admitVNextIntegration } from './integration-admission';
import { admitVNextGateResult } from './gate-admission';
import { admitVNextStageReview } from './review-admission';
import { admitVNextStageClose } from './stage-close-admission';
import { persistVNextStageReviewPreparation } from './review-preparation';
import { VNextNextActionService, persistVNextRoleContext, persistVNextWorkerContext } from './next';
// Version closure probes run through the SHARED credential discriminator —
// never a re-derived copy of its rules.
import { credentialSchemaVersionMismatch } from './cv-validation';
import {
  stageTailSchemaMismatch,
  VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS,
  VNEXT_CV_SCHEMA_VERSION,
  VNEXT_CV_SCHEMA_VERSION_SLICE_LOCAL,
  VNEXT_CREDENTIAL_SCHEMA_VERSION_V2,
  VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
} from './types';

/** Closed binding-mode vocabulary of a composed vNext Stage. */
export const VNEXT_COMPOSITION_BINDING_MODES = ['legacy-stage-wide', 'slice-local'] as const;
export type VNextCompositionBindingMode = (typeof VNEXT_COMPOSITION_BINDING_MODES)[number];

/** The five §9.4 closure dimensions. */
export const VNEXT_COMPOSITION_CLOSURES = [
  'behavior',
  'version',
  'count',
  'tip',
  'public-route',
] as const;
export type VNextCompositionClosure = (typeof VNEXT_COMPOSITION_CLOSURES)[number];

/**
 * One mechanically derived chain node (§9.3).  Every field is derived from the
 * Runtime/Contract — nothing is read from Task prose.
 */
export interface VNextCompositionChainStep {
  readonly step: string;
  readonly producer: string;
  readonly public_operation: string;
  readonly consumer: string;
  readonly accepted_binding_mode: VNextCompositionBindingMode;
  readonly accepted_schema: string;
  readonly required_predecessor: string | null;
  readonly required_binding: string;
  readonly restart_reader: string;
}

/** One §9.5 Stage-composition finding.  Never upgrades to PLAN_READY. */
export interface VNextCompositionGapFinding {
  readonly result: 'PLAN_DEFECT';
  readonly route_code: 'PLAN_GAP';
  readonly subtype: 'STAGE_COMPOSITION_GAP';
  /** Which §9.4 closure dimension failed. */
  readonly closure: VNextCompositionClosure;
  readonly missing_step: string;
  readonly slice_id?: string;
  readonly task_id?: string;
  readonly producer: string;
  readonly consumer: string;
  readonly binding_mode: VNextCompositionBindingMode;
  readonly expected_schema: string;
  readonly reason: string;
  readonly invalidation_scope: readonly ['candidate-plan'];
  readonly resume_target: { readonly owner: 'proofloop-plan'; readonly phase: 'STAGE_PLANNING' };
}

/** Named §9.4 tip definitions derived for one Slice. */
export interface VNextSliceCompositionTips {
  /** Last Manifest Task of the Slice (null when none is declared). */
  readonly task_coverage_tip: string | null;
  /** Finalize tip rule: exactly one finalize-slice fact, no task identity. */
  readonly finalize_tip: string;
  /** CV tip binding rule (worker chain tip digest). */
  readonly cv_tip: string;
  /** Commit tip binding rule. */
  readonly commit_tip: string;
  /** Integration tip binding rule. */
  readonly integration_tip: string;
}

/** Per-Slice derived composition. */
export interface VNextSliceCompositionAudit {
  readonly slice_id: string;
  /** Resolved Manifest task entity ids, in proof_index order. */
  readonly task_ids: readonly string[];
  /** N — the count-closure task cardinality of this Slice. */
  readonly task_count: number;
  /** Tip closure: last resolved Manifest Task (null when unsatisfiable). */
  readonly task_coverage_tip: string | null;
  /**
   * Count closure contract: exactly ONE finalize-slice fact closes this
   * Slice.  `finalize_unique_satisfiable: false` means the composition
   * (duplicate Slice id / zero tasks) makes the N→1 rule unverifiable.
   */
  readonly expected_finalize_count: 1;
  readonly finalize_unique_satisfiable: boolean;
  readonly tips: VNextSliceCompositionTips;
  readonly chain: readonly VNextCompositionChainStep[];
}

export interface VNextStageCompositionAuditResult {
  readonly closure_valid: boolean;
  readonly stage_id: string;
  readonly binding_mode: VNextCompositionBindingMode;
  /**
   * Version closure: the only legal slice-level credential payload
   * schema_version under the current binding mode (2 legacy / 3 slice-local),
   * bound to the real admission contract constants.
   */
  readonly accepted_slice_credential_schema: 2 | 3;
  readonly slices: readonly VNextSliceCompositionAudit[];
  readonly stage_chain: readonly VNextCompositionChainStep[];
  readonly findings: readonly VNextCompositionGapFinding[];
}

/** One row of the slice-level credential contract table (real constants). */
export interface VNextCredentialConsumerContract {
  readonly step: string;
  readonly consumer: string;
  /** Legal payload/envelope schema_version in legacy-stage-wide mode. */
  readonly legacy_schema: number;
  /** Legal payload/envelope schema_version in slice-local mode. */
  readonly slice_local_schema: number;
}

/**
 * The REAL admission-contract schema constants of every slice-level
 * credential consumer (CV repair #5): imported from the owning modules, never
 * restated.  The version closure binds `accepted_schema` to this table and
 * cross-checks it against the shared discriminator probe.
 */
export const VNEXT_SLICE_CREDENTIAL_CONTRACTS: readonly VNextCredentialConsumerContract[] = [
  {
    step: 'worker-admission',
    consumer: 'admitVNextWorkerResult',
    legacy_schema: VNEXT_CREDENTIAL_SCHEMA_VERSION_V2,
    slice_local_schema: VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
  },
  {
    step: 'cv-admission',
    consumer: 'admitVNextCVResult',
    legacy_schema: VNEXT_CV_SCHEMA_VERSION,
    slice_local_schema: VNEXT_CV_SCHEMA_VERSION_SLICE_LOCAL,
  },
  {
    step: 'slice-commit-admission',
    consumer: 'admitVNextSliceCommit',
    legacy_schema: VNEXT_CREDENTIAL_SCHEMA_VERSION_V2,
    slice_local_schema: VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
  },
  {
    step: 'integration-admission',
    consumer: 'admitVNextIntegration',
    legacy_schema: VNEXT_CREDENTIAL_SCHEMA_VERSION_V2,
    slice_local_schema: VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
  },
];

/**
 * Stage-tail credential contracts (CV repair R2 #4): built from the SAME
 * `VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS` map the real Gate/Review/Close
 * admission discriminators consume — no second fact source.
 */
export const VNEXT_STAGE_TAIL_CREDENTIAL_CONTRACTS: readonly {
  readonly step: string;
  readonly consumer: string;
  readonly credential_type: keyof typeof VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS;
  readonly schema_version: number;
}[] = [
  {
    step: 'gate-run',
    consumer: 'admitVNextGateResult',
    credential_type: 'GATE_RESULT',
    schema_version: VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS.GATE_RESULT,
  },
  {
    step: 'review-finalize',
    consumer: 'admitVNextStageReview',
    credential_type: 'STAGE_REVIEW_RESULT',
    schema_version: VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS.STAGE_REVIEW_RESULT,
  },
  {
    step: 'stage-close',
    consumer: 'admitVNextStageClose',
    credential_type: 'STAGE_CLOSE_RESULT',
    schema_version: VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS.STAGE_CLOSE_RESULT,
  },
];

/** Shared discriminator signature (kept abstract for drift injection tests). */
export type CredentialSchemaProbe = (
  schemaVersion: unknown,
  stageHasBinding: boolean,
  label: string,
) => { readonly message: string } | null;

const TASK_ENTITY_RE = /#\/entities\/([^/]+)$/;

/**
 * Prior-Stage dependency grammar (CV repair R2 #1): a complete canonical
 * `<stage-number>-<slice suffix>` token — the same shape execution Slice ids
 * use (`S14-B`).  Incomplete tokens such as `"S03-"` (empty suffix) are NOT
 * legal prior-Stage dependencies and fail closed as unknown dependencies.
 */
const PRIOR_STAGE_DEPENDENCY_RE = /^S(\d+)-([A-Za-z0-9._-]+)$/;

function finding(
  closure: VNextCompositionClosure,
  missingStep: string,
  producer: string,
  consumer: string,
  bindingMode: VNextCompositionBindingMode,
  expectedSchema: string,
  reason: string,
  scope: { readonly slice_id?: string; readonly task_id?: string } = {},
): VNextCompositionGapFinding {
  return {
    result: 'PLAN_DEFECT',
    route_code: 'PLAN_GAP',
    subtype: 'STAGE_COMPOSITION_GAP',
    closure,
    missing_step: missingStep,
    ...(scope.slice_id !== undefined ? { slice_id: scope.slice_id } : {}),
    ...(scope.task_id !== undefined ? { task_id: scope.task_id } : {}),
    producer,
    consumer,
    binding_mode: bindingMode,
    expected_schema: expectedSchema,
    reason,
    invalidation_scope: ['candidate-plan'],
    resume_target: { owner: 'proofloop-plan', phase: 'STAGE_PLANNING' },
  };
}

function isLiveFunction(value: unknown): boolean {
  return typeof value === 'function';
}

/**
 * Public-route closure: the step's operation must be part of the CLOSED public
 * CLI registry — a real `proofloop <domain> <operation>` route, not an
 * internal-only function call (§9.4).
 */
function routeRegistered(publicOperation: string): boolean {
  const [domain, operation] = publicOperation.split(' ');
  if (domain === undefined || operation === undefined) return false;
  const entry = (DOMAIN_REGISTRY as Record<string, { operations: readonly string[] } | undefined>)[domain];
  return entry !== undefined && entry.operations.includes(operation);
}

interface TaskAnchorError {
  readonly refId: string;
  readonly message: string;
}

/**
 * Resolve one Slice's Manifest task ids exactly like the execution next
 * consumer's anchor grammar (`taskIdsForSlice`), but non-throwing: an invalid
 * anchor becomes a count-closure finding instead of an unbounded runtime
 * exception after admission.
 */
function resolveSliceTaskIds(
  manifest: VNextManifest,
  slice: VNextManifestSlice,
): { taskIds: string[]; errors: TaskAnchorError[] } {
  const taskIds: string[] = [];
  const errors: TaskAnchorError[] = [];
  for (const refId of slice.proof_index.task_refs) {
    const descriptor = manifest.reference_index[refId];
    const match = descriptor === undefined ? undefined : TASK_ENTITY_RE.exec(descriptor.ref);
    if (descriptor?.kind !== 'task' || match?.[1] === undefined) {
      errors.push({
        refId,
        message: `task ref "${refId}" does not resolve to a task entity anchor (invalid dispatch anchor)`,
      });
      continue;
    }
    const taskId = match[1];
    if (!taskId.startsWith(`${slice.slice_id}-`)) {
      errors.push({
        refId,
        message: `task "${taskId}" is not bound to Slice "${slice.slice_id}"`,
      });
      continue;
    }
    taskIds.push(taskId);
  }
  return { taskIds, errors };
}

/** Duplicate declared Slice ids — they break task ownership and the N→1 finalize rule. */
function findDuplicateSliceIds(manifest: VNextManifest): string[] {
  const counts = new Map<string, number>();
  for (const slice of manifest.slices) {
    counts.set(slice.slice_id, (counts.get(slice.slice_id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

/**
 * Collect EVERY declared dependency reference first, then compare against the
 * declared Slice set (CV repair #2).  A reference outside the Manifest is
 * legal ONLY when it names a PRIOR Stage's Slice under the canonical grammar
 * (`^S<num>-…` with num strictly below the current Stage number); anything
 * else is an unknown dependency no dispatch can ever prove ready.
 */
function analyzeDeclaredDependencies(manifest: VNextManifest): {
  unknown: ReadonlyArray<{ readonly slice_id: string; readonly dependency: string }>;
  cycle: readonly string[] | null;
} {
  const declared = new Set(manifest.slices.map((slice) => slice.slice_id));
  const currentStageNumber =
    /^S(\d+)$/.exec(manifest.stage_id)?.[1] !== undefined
      ? Number(/^S(\d+)$/.exec(manifest.stage_id)![1])
      : null;
  const unknown: { slice_id: string; dependency: string }[] = [];
  for (const slice of manifest.slices) {
    for (const dependency of slice.depends_on) {
      if (declared.has(dependency)) continue;
      const priorMatch = PRIOR_STAGE_DEPENDENCY_RE.exec(dependency);
      const priorStageNumber = priorMatch?.[1] !== undefined ? Number(priorMatch[1]) : null;
      const legalPriorStageDependency =
        priorStageNumber !== null &&
        currentStageNumber !== null &&
        priorStageNumber < currentStageNumber;
      if (!legalPriorStageDependency) {
        unknown.push({ slice_id: slice.slice_id, dependency });
      }
    }
  }
  // Cycle detection over the DECLARED subgraph only (external prior-Stage
  // dependencies are ordered by Stage numbering, not by this Manifest).
  const edges = new Map<string, string[]>();
  for (const slice of manifest.slices) {
    edges.set(
      slice.slice_id,
      slice.depends_on.filter((dependency) => declared.has(dependency)),
    );
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    const marker = state.get(node);
    if (marker === 'done') return null;
    if (marker === 'visiting') {
      const start = stack.indexOf(node);
      return stack.slice(start === -1 ? 0 : start).concat(node);
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  let cycle: readonly string[] | null = null;
  for (const slice of manifest.slices) {
    cycle = visit(slice.slice_id);
    if (cycle !== null) break;
  }
  return { unknown, cycle }; // full loop incl. repeated entry node
}

/**
 * Derive the per-Slice expected chain (§9.2):
 * dispatch → worker admission → finalize-slice → CV → Slice Commit →
 * Integration.  All fields derive from the current binding mode.
 */
function sliceChainSteps(
  taskIds: readonly string[],
  bindingMode: VNextCompositionBindingMode,
): VNextCompositionChainStep[] {
  const credentialSchema =
    bindingMode === 'slice-local'
      ? `payload.schema_version ${VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL} (slice-local credential)`
      : `payload.schema_version ${VNEXT_CREDENTIAL_SCHEMA_VERSION_V2} (current vNext credential)`;
  const steps: VNextCompositionChainStep[] = [];
  for (const [index, taskId] of taskIds.entries()) {
    steps.push({
      step: `dispatch(${taskId})`,
      producer: 'brain (stage next)',
      public_operation: 'proofloop stage next',
      consumer: 'VNextNextActionService.nextAction (read-only decision)',
      accepted_binding_mode: bindingMode,
      accepted_schema: 'vNext NextActionOutput (read-only decision)',
      required_predecessor: index === 0 ? null : `worker-admission(${taskIds[index - 1]})`,
      required_binding: `manifest_digest + plan_digest + snapshot_digest + task_scopes[${taskId}]`,
      restart_reader: 'reconcileStage / deriveNextAction canonical lifecycle decision',
    });
    steps.push({
      step: `prepare-context(${taskId})`,
      producer: 'brain (context prepare)',
      public_operation: 'proofloop context prepare',
      consumer: 'persistVNextWorkerContext',
      accepted_binding_mode: bindingMode,
      accepted_schema: 'Context schema_version 2 (persistence seam)',
      required_predecessor: `dispatch(${taskId})`,
      required_binding: `context_digest + manifest_digest + plan_digest + snapshot_digest + task_scopes[${taskId}]`,
      restart_reader: 'persisted root-bound Worker Context (.proofloop/context)',
    });
    steps.push({
      step: `worker-admission(${taskId})`,
      producer: 'worker',
      public_operation: 'proofloop stage admit-worker',
      consumer: 'admitVNextWorkerResult',
      accepted_binding_mode: bindingMode,
      accepted_schema: credentialSchema,
      required_predecessor: `prepare-context(${taskId})`,
      required_binding: `context_digest + manifest/plan/proof_index/snapshot digests + execution_scope(${taskId})`,
      restart_reader: 'task-receipts(stage, slice) TASK_COMPLETE chain reader',
    });
  }
  steps.push({
    step: 'finalize-slice',
    producer: 'worker (completion mode finalize-slice)',
    public_operation: 'proofloop stage admit-worker',
    consumer: 'admitVNextWorkerResult',
    accepted_binding_mode: bindingMode,
    accepted_schema: credentialSchema,
    required_predecessor: taskIds.length > 0 ? `worker-admission(${taskIds[taskIds.length - 1]})` : null,
    required_binding: 'exactly 1 finalize fact per Slice, no task identity, worker chain tip',
    restart_reader: 'task-receipts(stage, slice) finalize fact reader',
  });
  steps.push({
    step: 'cv-admission',
    producer: 'code-verifier',
    public_operation: 'proofloop stage admit-cv',
    consumer: 'admitVNextCVResult',
    accepted_binding_mode: bindingMode,
    accepted_schema:
      bindingMode === 'slice-local'
        ? `envelope schema_version ${VNEXT_CV_SCHEMA_VERSION_SLICE_LOCAL} (slice-local)`
        : `envelope schema_version ${VNEXT_CV_SCHEMA_VERSION}`,
    required_predecessor: 'finalize-slice admitted',
    required_binding: 'worker_receipt_digest = Worker chain tip + context digest tuple',
    restart_reader: 'cv-receipts(root, stage, slice) CV chain reader',
  });
  steps.push({
    step: 'slice-commit-admission',
    producer: 'committer',
    public_operation: 'proofloop stage admit-slice-commit',
    consumer: 'admitVNextSliceCommit',
    accepted_binding_mode: bindingMode,
    accepted_schema: credentialSchema,
    required_predecessor: 'CV PASS tip',
    required_binding: 'cv_receipt_digest + commit_sha + changed_files boundary',
    restart_reader: 'committer-receipts(stage, slice) SLICE_COMMIT tip reader',
  });
  steps.push({
    step: 'integration-admission',
    producer: 'committer',
    public_operation: 'proofloop stage admit-integration',
    consumer: 'admitVNextIntegration',
    accepted_binding_mode: bindingMode,
    accepted_schema: credentialSchema,
    required_predecessor: 'slice-commit-admission receipt',
    required_binding: 'slice_commit_receipt_digest + dependency_bindings + integrated HEAD',
    restart_reader: 'integration-receipts(root, stage, slice) INTEGRATION_PASS chain reader',
  });
  return steps;
}

/**
 * Derive the Stage-level tail (§9.2) FROM THE DECLARED COMPOSITION (CV repair
 * #1): the Gate predecessor names the actual declared Slices whose
 * Integration tips it must consume; Review and Close predecessors follow the
 * derived Gate/Review tips.  An empty Slice declaration cannot define the
 * tail and is rejected by the caller via the returned sentinel.
 */
function stageChainSteps(
  manifest: VNextManifest,
  bindingMode: VNextCompositionBindingMode,
): { steps: VNextCompositionChainStep[]; declaredSliceIds: readonly string[] } {
  const declaredSliceIds = [...new Set(manifest.slices.map((slice) => slice.slice_id))];
  const gatePredecessor =
    declaredSliceIds.length > 0
      ? `integration-admission complete for every declared Slice (${declaredSliceIds.join(', ')})`
      : null;
  const steps: VNextCompositionChainStep[] = [
    {
      step: 'gate-run',
      producer: 'brain (gate runner)',
      public_operation: 'proofloop gate run',
      consumer: 'runGateVNext + admitVNextGateResult',
      accepted_binding_mode: bindingMode,
      accepted_schema: `GATE_RESULT payload schema_version ${VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS.GATE_RESULT}`,
      required_predecessor: gatePredecessor,
      required_binding: `per-Slice INTEGRATION_PASS tips (${declaredSliceIds.join(', ') || 'none declared'}) + stage_plan/spv receipts + HEAD snapshot`,
      restart_reader: 'stage-gate-receipts(stage) GATE tip reader',
    },
    {
      step: 'review-prepare',
      producer: 'brain (review assembler)',
      public_operation: 'proofloop review prepare-stage',
      consumer: 'persistVNextStageReviewPreparation',
      accepted_binding_mode: bindingMode,
      accepted_schema: `VNextStageReviewPreparation schema_version 2 (persisted prepared fact)`,
      required_predecessor: 'GATE PASS tip',
      required_binding: `gate receipt digest + Manifest/Plan binding tuple of stage ${manifest.stage_id}`,
      restart_reader: 'review-preparations(stage) prepared fact reader',
    },
    {
      step: 'review-finalize',
      producer: 'stage-reviewer',
      public_operation: 'proofloop review finalize-stage',
      consumer: 'admitVNextStageReview',
      accepted_binding_mode: bindingMode,
      accepted_schema: `STAGE_REVIEW_RESULT payload schema_version ${VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS.STAGE_REVIEW_RESULT}`,
      required_predecessor: 'GATE PASS tip (re-gate required after STAGE_REVIEW REPAIR)',
      required_binding: 'stage_gate_receipt_digest + verdict(ACCEPTED|REPAIR) + non-empty summary',
      restart_reader: 'review-receipts(stage) STAGE_REVIEW tip reader',
    },
    {
      step: 'stage-close',
      producer: 'brain/user-adjudicated close',
      public_operation: 'proofloop stage close',
      consumer: 'admitVNextStageClose',
      accepted_binding_mode: bindingMode,
      accepted_schema: `STAGE_CLOSE_RESULT payload schema_version ${VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS.STAGE_CLOSE_RESULT}`,
      required_predecessor: 'Stage Review ACCEPTED (full close)',
      required_binding: 'close_type(full|restricted) + non-empty reason + HEAD snapshot',
      restart_reader: 'readStageCloseFacts(stage) archived-facts probe',
    },
  ];
  return { steps, declaredSliceIds };
}

/**
 * Version closure core (CV repair #5): bind every slice-level credential
 * consumer's accepted schema to its REAL contract constants and cross-check
 * the winning constant against the shared discriminator probe.  Exported for
 * drift-injection regression tests — production callers pass the imported
 * `VNEXT_SLICE_CREDENTIAL_CONTRACTS` and `credentialSchemaVersionMismatch`.
 */
export function auditVersionClosure(
  contracts: readonly VNextCredentialConsumerContract[],
  hasBinding: boolean,
  probe: CredentialSchemaProbe,
  bindingMode: VNextCompositionBindingMode,
): VNextCompositionGapFinding[] {
  const findings: VNextCompositionGapFinding[] = [];
  const expected = hasBinding
    ? VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL
    : VNEXT_CREDENTIAL_SCHEMA_VERSION_V2;
  for (const contract of contracts) {
    const contractSchema = hasBinding ? contract.slice_local_schema : contract.legacy_schema;
    // (a) The consumer's own contract constants must agree with the audited
    //     binding-mode vocabulary — a drifted constant is a producer/consumer
    //     version split no chain can survive.
    if (contractSchema !== expected) {
      findings.push(
        finding(
          'version',
          `${contract.step}:credential-schema-drift`,
          `${contract.step} credential producer`,
          contract.consumer,
          bindingMode,
          `payload.schema_version ${expected}`,
          `${contract.consumer} accepts schema_version ${contractSchema} in ${bindingMode} mode; the admission contract vocabulary requires ${expected}`,
        ),
      );
      continue;
    }
    // (b) Cross-check the shared discriminator: the contract-legal version
    //     must be accepted, every other known version must be rejected.
    for (const candidate of [1, 2, 3]) {
      const rejected = probe(candidate, hasBinding, `Stage Composition Closure Audit probe/${contract.consumer}`);
      const legal = rejected === null;
      if (legal !== (candidate === contractSchema)) {
        findings.push(
          finding(
            'version',
            `${contract.step}:credential-schema-discrimination`,
            `${contract.step} credential producer`,
            contract.consumer,
            bindingMode,
            `payload.schema_version ${contractSchema}`,
            `shared credential discriminator ${legal ? 'accepts' : 'rejects'} schema_version ${candidate} in ${bindingMode} mode while ${contract.consumer} declares ${contractSchema} as the only legal credential`,
          ),
        );
      }
    }
  }
  // Unknown future versions must stay fail-closed in every mode.
  if (probe(expected + 1, hasBinding, 'Stage Composition Closure Audit probe/future') === null) {
    findings.push(
      finding(
        'version',
        'credential-schema-future',
        'any future credential producer',
        'every vNext admission consumer',
        bindingMode,
        `payload.schema_version ≤ ${expected}`,
        'shared credential discriminator accepted an unknown future schema_version; consumers would not fail closed',
      ),
    );
  }
  return findings;
}

/**
 * Public-route wiring closure (CV repair R2 #2): every derived step's
 * `public_operation` must map onto the single acyclic route table row whose
 * consumer matches the step and whose consumer seam is live.  Exported for
 * drift-injection regression tests — production callers pass
 * `VNEXT_ROUTE_TABLE` and their liveness map.
 */
export function auditRouteTableWiring(
  steps: readonly VNextCompositionChainStep[],
  routeTable: ReadonlyMap<string, { readonly handler: string; readonly consumer: string; readonly schema_seam: string }>,
  liveConsumers: Readonly<Record<string, unknown>>,
  bindingMode: VNextCompositionBindingMode,
): VNextCompositionGapFinding[] {
  const findings: VNextCompositionGapFinding[] = [];
  const mapped = new Set<string>();
  for (const step of steps) {
    const operationPath = step.public_operation.replace(/^proofloop /, '');
    const entry = routeTable.get(operationPath);
    if (entry === undefined) {
      findings.push(
        finding(
          'public-route',
          step.step,
          step.producer,
          step.consumer,
          bindingMode,
          step.accepted_schema,
          `"${step.public_operation}" has no closed route-table wiring entry; the producer action cannot be proven to reach any closed handler/consumer/schema seam`,
        ),
      );
      continue;
    }
    mapped.add(operationPath);
    // One public operation may fan out to several consumer seams ('|'-separated);
    // a trailing "(…)" mode suffix is presentation, not a different seam.
    const normalizeConsumer = (consumer: string): string => consumer.replace(/\s*\([^)]*\)$/, '');
    const entryConsumers = entry.consumer.split('|').map((consumer) => consumer.trim());
    const normalizedStep = normalizeConsumer(step.consumer);
    const matches = entryConsumers.some(
      (candidate) => normalizeConsumer(candidate) === normalizedStep || candidate === step.consumer,
    );
    if (!matches) {
      findings.push(
        finding(
          'public-route',
          step.step,
          step.producer,
          step.consumer,
          bindingMode,
          step.accepted_schema,
          `route table maps "${step.public_operation}" to consumers [${entryConsumers.join(', ')}], but the derived chain consumer is "${step.consumer}"; the handler/consumer mapping is inconsistent`,
        ),
      );
    }
    for (const candidate of entryConsumers) {
      const normalizedCandidate = normalizeConsumer(candidate);
      const known =
        candidate in liveConsumers || normalizedCandidate in liveConsumers;
      if (!known) {
        // Strict closure: an unmapped consumer name is an UNPROBED row — it
        // must never silently count as closed (the CLI smoke matrix only
        // proves rows this audit already models).
        findings.push(
          finding(
            'behavior',
            step.step,
            step.producer,
            candidate,
            bindingMode,
            step.accepted_schema,
            `route table consumer "${candidate}" has no liveness-map entry; the closure audit cannot prove the seam exists`,
          ),
        );
        continue;
      }
      const seam = liveConsumers[candidate] ?? liveConsumers[normalizedCandidate];
      if (!isLiveFunction(seam)) {
        findings.push(
          finding(
            'behavior',
            step.step,
            step.producer,
            candidate,
            bindingMode,
            step.accepted_schema,
            `route table consumer "${candidate}" is not a live runtime function; the public operation cannot reach its admission seam`,
          ),
        );
      }
    }
  }
  for (const [operation, entry] of routeTable) {
    if (!mapped.has(operation)) continue;
    void entry;
  }
  return findings;
}

/**
 * Run the mechanical Stage Composition Closure Audit over a compiled vNext
 * Manifest.  Pure derivation over the Manifest object — no filesystem, no
 * receipts, no writes.
 */
export function auditVNextStageComposition(manifest: VNextManifest): VNextStageCompositionAuditResult {
  const bindingMode: VNextCompositionBindingMode =
    manifest.binding !== undefined ? 'slice-local' : 'legacy-stage-wide';
  const expectedCredentialSchema: 2 | 3 = manifest.binding !== undefined ? 3 : 2;
  const findings: VNextCompositionGapFinding[] = [];

  // ── 版本闭环 (§9.4 version closure, CV repair #5) ────────────────────────
  // Bound to the REAL admission contract constants of every slice-level
  // credential consumer, cross-checked through the shared discriminator.
  findings.push(
    ...auditVersionClosure(
      VNEXT_SLICE_CREDENTIAL_CONTRACTS,
      manifest.binding !== undefined,
      credentialSchemaVersionMismatch,
      bindingMode,
    ),
  );
  // Stage-tail credentials run through the SHARED discriminator that the real
  // Gate/Review/Close validators use — a drifted or unknown version produces
  // the exact fail-closed message those consumers will emit.
  for (const contract of VNEXT_STAGE_TAIL_CREDENTIAL_CONTRACTS) {
    const mismatch = stageTailSchemaMismatch(contract.schema_version, contract.credential_type, contract.step);
    if (mismatch !== null) {
      findings.push(
        finding(
          'version',
          `${contract.step}:schema-drift`,
          contract.step,
          contract.consumer,
          bindingMode,
          `payload.schema_version ${VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS[contract.credential_type]}`,
          mismatch,
        ),
      );
    }
  }

  // ── 数量 / Tip 闭环 per Slice (CV repair #4) ─────────────────────────────
  const duplicateSliceIds = findDuplicateSliceIds(manifest);
  for (const duplicateId of duplicateSliceIds) {
    findings.push(
      finding(
        'count',
        `finalize-slice(${duplicateId})`,
        'worker (completion mode finalize-slice)',
        'admitVNextWorkerResult (mode discrimination)',
        bindingMode,
        'unique declared Slice ids',
        `Slice "${duplicateId}" is declared more than once; task ownership and the exactly-one-finalize N→1 rule become undefined`,
        { slice_id: duplicateId },
      ),
    );
  }

  const slices: VNextSliceCompositionAudit[] = [];
  const seenTaskOwners = new Map<string, string>();
  for (const slice of manifest.slices) {
    const { taskIds, errors } = resolveSliceTaskIds(manifest, slice);
    for (const anchorError of errors) {
      findings.push(
        finding(
          'count',
          `dispatch(${anchorError.refId})`,
          'brain (vNext next/context seam)',
          'projectVNextWorkerDispatch',
          bindingMode,
          'Context schema_version 2',
          `Slice "${slice.slice_id}" cannot be counted into the task chain: ${anchorError.message}`,
          { slice_id: slice.slice_id },
        ),
      );
    }
    for (const taskId of taskIds) {
      const owner = seenTaskOwners.get(taskId);
      if (owner !== undefined) {
        findings.push(
          finding(
            'count',
            `dispatch(${taskId})`,
            'brain (vNext next/context seam)',
            'projectVNextWorkerDispatch',
            bindingMode,
            `N tasks total across ${manifest.slices.length} declared Slice(s)`,
            `task "${taskId}" is anchored by both Slice "${owner}" and Slice "${slice.slice_id}"; downstream would double-count the same Manifest Task`,
            { slice_id: slice.slice_id, task_id: taskId },
          ),
        );
      } else {
        seenTaskOwners.set(taskId, slice.slice_id);
      }
    }
    // Tip closure: without at least one resolvable Manifest Task the Slice has
    // no task coverage tip, so finalize/CV predecessor chains are undefined
    // and the exactly-one-finalize rule is not satisfiable.
    const taskCoverageTip = taskIds.length > 0 ? taskIds[taskIds.length - 1] : null;
    if (taskCoverageTip === null) {
      findings.push(
        finding(
          'tip',
          'finalize-slice',
          'worker (completion mode finalize-slice)',
          'admitVNextWorkerResult (mode discrimination)',
          bindingMode,
          'at least 1 resolvable Manifest Task per Slice',
          `Slice "${slice.slice_id}" has no resolvable task_refs; its task coverage tip is undefined so finalize-slice has no provable predecessor chain`,
          { slice_id: slice.slice_id },
        ),
      );
    }
    slices.push({
      slice_id: slice.slice_id,
      task_ids: taskIds,
      task_count: taskIds.length,
      task_coverage_tip: taskCoverageTip,
      expected_finalize_count: 1,
      finalize_unique_satisfiable:
        taskCoverageTip !== null && !duplicateSliceIds.includes(slice.slice_id),
      tips: {
        task_coverage_tip: taskCoverageTip,
        // Real digest-field contracts from the admission consumers (CV repair
        // R2 #3): each downstream tip binds a persisted Receipt digest field,
        // never a Task id.
        finalize_tip:
          'exactly one finalize-slice TASK_COMPLETE payload (no task_id, worker chain TIP digest)',
        cv_tip: 'CV envelope.worker_receipt_digest must equal the persisted Worker Receipt chain tip digest',
        commit_tip: 'SLICE_COMMIT cv_receipt_digest must equal the admitted CV PASS receipt digest (chain tip)',
        integration_tip:
          'INTEGRATION_PASS binds slice_commit_receipt_digest + worker_receipt_digest + cv_receipt_digest from the persisted chains',
      },
      chain: sliceChainSteps(taskIds, bindingMode),
    });
  }

  // ── 行为闭环 (§9.4 behavior closure, CV repair #2) ───────────────────────
  // Every declared dependency reference is collected FIRST, then compared
  // against the declared Slice set; out-of-Manifest references are legal only
  // as prior-Stage dependencies under the canonical grammar.
  const { unknown: unknownDependencies, cycle } = analyzeDeclaredDependencies(manifest);
  for (const entry of unknownDependencies) {
    findings.push(
      finding(
        'behavior',
        `dispatch(first task of ${entry.slice_id})`,
        'brain (vNext next/context seam)',
        'projectVNextWorkerDispatch',
        bindingMode,
        'resolvable declared dependency',
        `Slice "${entry.slice_id}" depends on "${entry.dependency}", which is neither a declared Slice nor a provable prior-Stage dependency (expected ^S<num>- with num < the current Stage number); serial dispatch can never prove readiness`,
        { slice_id: entry.slice_id },
      ),
    );
  }
  if (cycle !== null) {
    findings.push(
      finding(
        'behavior',
        'dispatch(dependency-ready Slice)',
        'brain (vNext next/context seam)',
        'projectVNextWorkerDispatch',
        bindingMode,
        'acyclic declared depends_on graph',
        `declared dependency cycle ${cycle.join(' -> ')}; no Slice in the cycle can ever become dependency-ready`,
      ),
    );
  }

  // ── Stage tail derivation (CV repair #1) ─────────────────────────────────
  // The tail is derived from the DECLARED Slices; a composition without any
  // Slice cannot define the Gate predecessor and fails closed.
  const { steps: stageChain, declaredSliceIds } = stageChainSteps(manifest, bindingMode);
  if (declaredSliceIds.length === 0) {
    findings.push(
      finding(
        'behavior',
        'gate-run',
        'brain (gate runner)',
        'runGateVNext + admitVNextGateResult',
        bindingMode,
        'at least 1 declared Slice',
        'the Manifest declares zero Slices; the Stage tail (Gate → Review → Close) has no derivable predecessor chain',
      ),
    );
  }

  // ── 链路推导 + 公共路由 + consumer/dispatcher liveness (CV repair #3) ────
  // Behavior closure liveness tables — the named runtime seams must be live
  // functions or the expected action has no downstream consumer.
  const seamLiveness: Record<string, unknown> = {
    'VNextNextActionService.nextAction (read-only decision)': VNextNextActionService,
    'persistVNextWorkerContext': persistVNextWorkerContext,
    'persistVNextRoleContext': persistVNextRoleContext,
    'projectVNextWorkerDispatch + persistVNextWorkerContext': projectVNextWorkerDispatch,
    'persistVNextStageReviewPreparation': persistVNextStageReviewPreparation,
    'admitVNextWorkerResult': admitVNextWorkerResult,
    'admitVNextWorkerResult (mode discrimination)': admitVNextWorkerResult,
    'admitVNextCVResult': admitVNextCVResult,
    'admitVNextSliceCommit': admitVNextSliceCommit,
    'admitVNextIntegration': admitVNextIntegration,
    'runGateVNext + admitVNextGateResult': admitVNextGateResult,
    'admitVNextStageReview': admitVNextStageReview,
    'admitVNextStageClose': admitVNextStageClose,
  };
  const dirLiveness: ReadonlyArray<readonly [string, unknown]> = [
    ['task-receipts', tasksReceiptDir],
    ['cv-receipts', cvReceiptDir],
    ['committer-receipts', committerReceiptDir],
    ['integration-receipts', integrationReceiptDir],
    ['stage-gate-receipts', stageGateReceiptDir],
    ['review-receipts', reviewReceiptDir],
  ];
  const sliceIdOfStep = new Map<string, string>();
  for (const slice of slices) {
    for (const step of slice.chain) sliceIdOfStep.set(step.step, slice.slice_id);
  }
  for (const step of [...slices.flatMap((slice) => slice.chain), ...stageChain]) {
    // Public-route closure against the closed CLI registry.
    const operationPath = step.public_operation.replace(/^proofloop /, '');
    if (!routeRegistered(operationPath)) {
      findings.push(
        finding(
          'public-route',
          step.step,
          step.producer,
          step.consumer,
          bindingMode,
          step.accepted_schema,
          `step routes through "${step.public_operation}", which is not part of the closed public CLI registry`,
          { slice_id: sliceIdOfStep.get(step.step) },
        ),
      );
    }
    // Behavior closure: every named runtime consumer seam must be a live
    // function. A '|'-composite consumer names SEPARATE seams — each member
    // is probed; an unknown member is itself a closure gap (an unprobed row
    // must never silently count as closed).
    const seamNames = step.consumer
      .split('|')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    for (const seamName of seamNames) {
      const seam = seamLiveness[seamName];
      if (seam === undefined) {
        findings.push(
          finding(
            'behavior',
            step.step,
            step.producer,
            seamName,
            bindingMode,
            step.accepted_schema,
            `consumer seam "${seamName}" has no liveness-map entry; the closure audit cannot prove the seam exists`,
          ),
        );
        continue;
      }
      if (!isLiveFunction(seam)) {
        findings.push(
          finding(
            'behavior',
            step.step,
            step.producer,
            seamName,
            bindingMode,
            step.accepted_schema,
            `consumer seam "${seamName}" is not a live runtime function; the expected action has no downstream consumer`,
          ),
        );
      }
    }
    // Persistence layout liveness: every restart reader names a receipt-layout
    // seam that must exist for restart to re-derive the category.
    for (const [prefix, fn] of dirLiveness) {
      if (step.restart_reader.startsWith(`${prefix}(`) && !isLiveFunction(fn)) {
        findings.push(
          finding(
            'behavior',
            step.step,
            step.producer,
            step.restart_reader,
            bindingMode,
            step.accepted_schema,
            `restart reader layout seam "${prefix}" is not a live runtime function; persisted facts could not be re-derived after restart`,
          ),
        );
      }
    }
  }

  // Route-table wiring closure against the single acyclic fact source (the
  // same table the top-level proofloopCli smoke matrix exercises).
  findings.push(
    ...auditRouteTableWiring(
      [...slices.flatMap((slice) => slice.chain), ...stageChain],
      new Map(VNEXT_ROUTE_TABLE.map((entry) => [entry.operation, entry])),
      seamLiveness,
      bindingMode,
    ),
  );

  return {
    closure_valid: findings.length === 0,
    stage_id: manifest.stage_id,
    binding_mode: bindingMode,
    accepted_slice_credential_schema: expectedCredentialSchema,
    slices,
    stage_chain: stageChain,
    findings,
  };
}
