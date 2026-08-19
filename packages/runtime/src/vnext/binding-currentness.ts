/**
 * @proofloop/runtime — slice currentness for slice-local binding mode
 * (S12-D-T01).
 *
 * Consumes historical Slice proofs at Slice level instead of the whole-plan
 * digest (tech-spec/contract-state-matrix.md §8.5/§8.6 and
 * ai-coding-architecture.md §10.5). The mechanical criterion for an
 * INTEGRATED slice staying valid is `isIntegratedSliceCurrent`:
 *
 *   stage_contract current ∧ slice_contract current ∧
 *   dependency binding current ∧ integration receipt chain valid
 *
 * The dependency-binding criterion (S12-D repair): a slice that DECLARES a
 * dependency (`depends_on` non-empty) must carry a receipt-bound binding
 * entry for EVERY declared dependency — a missing/empty
 * `dependencyBindings` cannot prove the dependency current and fails closed
 * as STALE_DEPENDENCY. A binding whose `integration_head_sha` differs from
 * the current Integration Receipt of the dependency slice is stale too
 * (the dependency's integration facts changed).
 *
 * and it NO LONGER auto-invalidates on whole-plan plan_digest /
 * manifest_digest history differences (FR-020 Case 1/2/5 semantics).
 *
 * State dimensions (§8.5):
 *   CURRENT          — stage/slice contract + dependency binding + receipt
 *                      chain all current;
 *   STALE_CONTRACT   — the slice's OWN slice_contract_digest changed
 *                      (re-run this slice, plus its reverse dependency
 *                      closure);
 *   STALE_DEPENDENCY — a dependency Slice's integration facts changed, or the
 *                      slice is inside reverseDependencyClosure(changed)
 *                      (§10.5: invalidated = changed ∪
 *                      reverseDependencyClosure(changed));
 *   INVALIDATED      — stage_contract_digest changed (all slices re-run).
 *
 * Digest comparison contract: the CURRENT stage/slice contract digests are
 * produced ONLY by the kernel bindings.ts oracle (imported from
 * `@proofloop/kernel/dist/vnext` — the S12-B forward note: runtime consumes
 * the built subpath surface). The current stage_contract_digest is taken
 * from the compiled manifest's `binding.stage_contract_digest` (the compiler
 * computed it through the oracle at compile time, S12-C); the current
 * slice_contract_digest of every integrated slice is recomputed here through
 * `computeSliceContractDigest`. The RECEIPT-BOUND digests come from the
 * integration receipt chain (`integrationReceipts`) / the top-level bound
 * digest fields. This module never re-implements hash logic and never
 * accepts caller-supplied digests as computation.
 *
 * Scope rules:
 * - This module is slice-local ONLY. A legacy manifest (no `binding`
 *   section) passed here fails closed — the legacy path is untouched and
 *   lives elsewhere.
 * - The criterion is defined for INTEGRATED slices (§10.5). An un-integrated
 *   slice (no receipt in the chain) fails closed: un-integrated slices are
 *   re-run without consulting currentness (§10.5: no auto carry-forward
 *   across Plan revisions).
 * - Pure functions: no I/O. All malformed input (null / missing / malformed
 *   fields) fails closed with a typed `SchemaValidationError` (code
 *   `RUNTIME.SCHEMA_MISMATCH`), never a native TypeError.
 */

import {
  SchemaValidationError,
  isSha256Hex,
  type VNextManifest,
} from '@proofloop/kernel';
import {
  computeSliceContractDigest,
  validateDependencyBinding,
  VNEXT_BINDING_SCHEMA_VERSION,
  VNEXT_BINDING_MODES,
  type VNextDependencyBinding,
} from '@proofloop/kernel/dist/vnext';

// ============================================================
// Public contract
// ============================================================

/** Closed set of slice currentness states (§8.5). */
export const SLICE_CURRENTNESS_STATES = [
  'CURRENT',
  'STALE_CONTRACT',
  'STALE_DEPENDENCY',
  'INVALIDATED',
] as const;

export type SliceCurrentness = (typeof SLICE_CURRENTNESS_STATES)[number];

/**
 * One entry of the current integration receipt chain of the Stage.
 *
 * `receipt_digest` is the SHA-256 digest of the integration receipt payload;
 * `integration_head_sha` is the canonical 40-hex git HEAD after that slice's
 * integration; `stage_contract_digest` / `slice_contract_digest` are the
 * digests the receipt BOUND at integration time (§8.1/§8.2).
 */
export interface IntegrationReceiptRef {
  readonly slice_id: string;
  readonly receipt_digest: string;
  readonly integration_head_sha: string;
  readonly stage_contract_digest: string;
  readonly slice_contract_digest: string;
}

/**
 * Input of `computeSliceCurrentness` / `isIntegratedSliceCurrent`.
 *
 * - `manifest` — the CURRENT compiled manifest (slice-local mode). Its
 *   `binding.stage_contract_digest` is the current stage contract digest
 *   (kernel-oracle computed at compile time, S12-C).
 * - `sliceId` — the integrated slice being evaluated.
 * - `manifestDigest` / `planDigest` — historical whole-plan digests, accepted
 *   for API compatibility. They are NEVER part of the decision: a difference
 *   in whole-plan digest history must not auto-invalidate (FR-020).
 * - `stageContractDigest` / `sliceContractDigest` — the digests BOUND by the
 *   target slice's integration receipt (must match the chain entry).
 * - `dependencyBindings` — the receipt-bound dependency integration facts of
 *   the target slice's execution binding (`dependency_bindings`, §8.2).
 * - `integrationReceipts` — the Stage's current integration receipt chain.
 */
export interface ComputeSliceCurrentnessInput {
  readonly manifest: VNextManifest;
  readonly sliceId: string;
  readonly manifestDigest?: string;
  readonly planDigest?: string;
  readonly stageContractDigest: string;
  readonly sliceContractDigest: string;
  readonly dependencyBindings: readonly VNextDependencyBinding[];
  readonly integrationReceipts: readonly IntegrationReceiptRef[];
}

/** One node of the dependency graph used by `computeReverseDependencyClosure`. */
export interface SliceDependencyGraphNode {
  readonly slice_id: string;
  readonly depends_on: readonly string[];
}

// ============================================================
// Fail-closed helpers
// ============================================================

const GIT_SHA_RE = /^[a-f0-9]{40}$/;

function fail(message: string, path: string): never {
  throw new SchemaValidationError(`BindingCurrentness: ${message}`, [{ path, message }]);
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Expected a non-empty string at ${path}`, path);
  }
  return value;
}

function expectSha256Hex(value: unknown, path: string): string {
  if (typeof value !== 'string' || !isSha256Hex(value)) {
    fail(`Expected a 64-char lowercase hex sha256 digest at ${path}`, path);
  }
  return value;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`Expected an object at ${path}`, path);
  }
  return value as Record<string, unknown>;
}

// ============================================================
// Reverse dependency closure (§10.5)
// ============================================================

/**
 * Compute the §10.5 invalidation closure:
 *
 *   invalidated = changedSliceIds ∪ reverseDependencyClosure(changedSliceIds)
 *
 * over the slice dependency graph (a slice depends on `depends_on`; a
 * change to a slice invalidates every slice that transitively depends on
 * it). Pure, deterministic (sorted result), fail-closed on malformed input
 * (typed `SchemaValidationError`, never a native TypeError).
 *
 * @throws {SchemaValidationError} on non-array input, a non-object /
 *   malformed graph node, duplicate slice_ids, a slice depending on itself
 *   or on an unknown slice, a non-array / malformed `changedSliceIds`, a
 *   duplicate changed id, or a changed id that is not in the graph.
 */
export function computeReverseDependencyClosure(
  slices: readonly SliceDependencyGraphNode[],
  changedSliceIds: readonly string[],
): string[] {
  if (!Array.isArray(slices)) {
    fail('slices must be an array of dependency graph nodes', 'slices');
  }
  if (!Array.isArray(changedSliceIds)) {
    fail('changedSliceIds must be an array of slice ids', 'changedSliceIds');
  }

  const graph = new Map<string, { slice_id: string; depends_on: string[] }>();
  for (let i = 0; i < slices.length; i++) {
    const node = expectObject(slices[i], `slices[${i}]`);
    const sliceId = expectNonEmptyString(node.slice_id, `slices[${i}].slice_id`);
    if (graph.has(sliceId)) {
      fail(`duplicate slice_id "${sliceId}" in the dependency graph`, `slices[${i}].slice_id`);
    }
    const dependsOn = node.depends_on;
    if (
      !Array.isArray(dependsOn) ||
      dependsOn.some((dep) => typeof dep !== 'string' || dep.length === 0)
    ) {
      fail(`slices[${i}].depends_on must be an array of non-empty slice ids`, `slices[${i}].depends_on`);
    }
    if (dependsOn.includes(sliceId)) {
      fail(`slice "${sliceId}" must not depend on itself`, `slices[${i}].depends_on`);
    }
    graph.set(sliceId, { slice_id: sliceId, depends_on: [...(dependsOn as string[])] });
  }

  for (const node of graph.values()) {
    for (const dep of node.depends_on) {
      if (!graph.has(dep)) {
        fail(`slice "${node.slice_id}" depends on unknown slice "${dep}"`, `slices.${node.slice_id}.depends_on`);
      }
    }
  }

  const changed = new Set<string>();
  for (let i = 0; i < changedSliceIds.length; i++) {
    const id = changedSliceIds[i];
    if (typeof id !== 'string' || id.length === 0) {
      fail(`changedSliceIds[${i}] must be a non-empty slice id`, `changedSliceIds[${i}]`);
    }
    if (changed.has(id)) {
      fail(`duplicate changed slice "${id}"`, `changedSliceIds[${i}]`);
    }
    if (!graph.has(id)) {
      fail(`changed slice "${id}" is not in the dependency graph`, `changedSliceIds[${i}]`);
    }
    changed.add(id);
  }

  // Reverse adjacency: slice → slices that depend on it.
  const dependents = new Map<string, string[]>();
  for (const node of graph.values()) {
    for (const dep of node.depends_on) {
      const list = dependents.get(dep);
      if (list === undefined) {
        dependents.set(dep, [node.slice_id]);
      } else {
        list.push(node.slice_id);
      }
    }
  }

  // BFS from the changed set along reverse edges (visited set terminates
  // cycles; a malformed cyclic graph is still computed deterministically).
  const invalidated = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of dependents.get(current) ?? []) {
      if (!invalidated.has(dependent)) {
        invalidated.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return [...invalidated].sort();
}

// ============================================================
// Slice currentness (§8.5 / §10.5)
// ============================================================

/**
 * Evaluate the currentness state of one INTEGRATED slice in slice-local
 * binding mode (§8.5).
 *
 * Decision order (fail-closed, typed errors only):
 *   1. INVALIDATED when the current stage_contract_digest (manifest binding)
 *      differs from the receipt-bound stage digest;
 *   2. STALE_CONTRACT when the slice's own slice_contract_digest changed;
 *   3. STALE_DEPENDENCY when the slice is inside
 *      `changed ∪ reverseDependencyClosure(changed)` (Case 2 chain
 *      invalidation), a DECLARED dependency has no receipt-bound binding
 *      entry (missing/empty dependencyBindings for a depends_on slice), or a
 *      direct dependency binding is no longer current (dependency slice
 *      contract / integration receipt digest / integration HEAD changed);
 *   4. CURRENT otherwise.
 *
 * Whole-plan `planDigest` / `manifestDigest` are accepted but never
 * influence the verdict (FR-020).
 *
 * @throws {SchemaValidationError} on any malformed input — null input,
 *   a legacy manifest (no `binding`), malformed digests, malformed
 *   dependency bindings / receipt chain entries, duplicate chain slice_ids,
 *   an unknown target slice, a target slice without an integration receipt,
 *   or top-level bound digests contradicting the receipt chain. Never a
 *   native TypeError.
 */
export function computeSliceCurrentness(input: ComputeSliceCurrentnessInput): SliceCurrentness {
  // ---- fail-closed input validation ----
  const obj = expectObject(input, 'input');
  const manifest = expectObject(obj.manifest, 'input.manifest') as unknown as VNextManifest;
  const sliceId = expectNonEmptyString(obj.sliceId, 'input.sliceId');
  if (obj.manifestDigest !== undefined) expectSha256Hex(obj.manifestDigest, 'input.manifestDigest');
  if (obj.planDigest !== undefined) expectSha256Hex(obj.planDigest, 'input.planDigest');
  const boundStageDigest = expectSha256Hex(obj.stageContractDigest, 'input.stageContractDigest');
  const boundSliceDigest = expectSha256Hex(obj.sliceContractDigest, 'input.sliceContractDigest');

  // Slice-local mode only: legacy stages use the legacy path untouched. A
  // manifest whose `binding` is null is a malformed/legacy manifest — never
  // a slice-local one — and fails closed with the typed error (S12-D repair:
  // previously `binding.mode` dereferenced null and leaked a native
  // TypeError).
  const binding = manifest.binding;
  if (binding === null || binding === undefined || binding.mode !== VNEXT_BINDING_MODES[0]) {
    fail(
      'slice currentness requires a slice-local manifest (manifest.binding.mode === "slice-local"); ' +
        'legacy manifests (no binding) use the legacy path and must not be evaluated here',
      'input.manifest.binding',
    );
  }
  if (binding.version !== VNEXT_BINDING_SCHEMA_VERSION) {
    fail(`unexpected binding schema version ${JSON.stringify(binding.version)}`, 'input.manifest.binding.version');
  }
  expectSha256Hex(binding.stage_contract_digest, 'input.manifest.binding.stage_contract_digest');

  const dependencyBindings = obj.dependencyBindings;
  if (!Array.isArray(dependencyBindings)) {
    fail('input.dependencyBindings must be an array', 'input.dependencyBindings');
  }
  const boundDepIds = new Set<string>();
  for (let i = 0; i < dependencyBindings.length; i++) {
    // Kernel closed validator: shape + unknown-field rejection, typed error.
    validateDependencyBinding(dependencyBindings[i]);
    const dep = dependencyBindings[i] as VNextDependencyBinding;
    if (boundDepIds.has(dep.slice_id)) {
      fail(`duplicate dependency binding for slice "${dep.slice_id}"`, `input.dependencyBindings[${i}].slice_id`);
    }
    boundDepIds.add(dep.slice_id);
  }

  const receipts = obj.integrationReceipts;
  if (!Array.isArray(receipts)) {
    fail('input.integrationReceipts must be an array', 'input.integrationReceipts');
  }
  const receiptsBySlice = new Map<string, IntegrationReceiptRef>();
  for (let i = 0; i < receipts.length; i++) {
    const ref = expectObject(receipts[i], `input.integrationReceipts[${i}]`);
    const refSliceId = expectNonEmptyString(ref.slice_id, `input.integrationReceipts[${i}].slice_id`);
    expectSha256Hex(ref.receipt_digest, `input.integrationReceipts[${i}].receipt_digest`);
    const head = ref.integration_head_sha;
    if (typeof head !== 'string' || !GIT_SHA_RE.test(head)) {
      fail(
        `Expected a 40-char lowercase hex git sha at input.integrationReceipts[${i}].integration_head_sha`,
        `input.integrationReceipts[${i}].integration_head_sha`,
      );
    }
    expectSha256Hex(ref.stage_contract_digest, `input.integrationReceipts[${i}].stage_contract_digest`);
    expectSha256Hex(ref.slice_contract_digest, `input.integrationReceipts[${i}].slice_contract_digest`);
    if (receiptsBySlice.has(refSliceId)) {
      fail(`duplicate integration receipt for slice "${refSliceId}"`, `input.integrationReceipts[${i}].slice_id`);
    }
    receiptsBySlice.set(refSliceId, {
      slice_id: refSliceId,
      receipt_digest: ref.receipt_digest as string,
      integration_head_sha: head,
      stage_contract_digest: ref.stage_contract_digest as string,
      slice_contract_digest: ref.slice_contract_digest as string,
    });
  }

  const manifestSlices = new Map<string, { slice_id: string; depends_on: string[] }>();
  if (!Array.isArray(manifest.slices) || manifest.slices.length === 0) {
    fail('input.manifest.slices must be a non-empty array', 'input.manifest.slices');
  }
  for (let i = 0; i < manifest.slices.length; i++) {
    const slice = expectObject(manifest.slices[i], `input.manifest.slices[${i}]`);
    const id = expectNonEmptyString(slice.slice_id, `input.manifest.slices[${i}].slice_id`);
    if (manifestSlices.has(id)) {
      fail(`duplicate slice "${id}" in manifest`, `input.manifest.slices[${i}].slice_id`);
    }
    const dependsOn = slice.depends_on;
    if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== 'string')) {
      fail(`input.manifest.slices[${i}].depends_on must be an array of slice ids`, `input.manifest.slices[${i}].depends_on`);
    }
    manifestSlices.set(id, { slice_id: id, depends_on: [...(dependsOn as string[])] });
  }

  if (!manifestSlices.has(sliceId)) {
    fail(`slice "${sliceId}" not found in the manifest`, 'input.sliceId');
  }

  // The criterion is defined for INTEGRATED slices (§10.5); an un-integrated
  // slice is re-run without consulting currentness.
  const targetReceipt = receiptsBySlice.get(sliceId);
  if (targetReceipt === undefined) {
    fail(
      `slice "${sliceId}" has no integration receipt in the chain — ` +
        'slice currentness is defined for INTEGRATED slices; un-integrated slices are re-run without ' +
        'consulting currentness (§10.5)',
      'input.integrationReceipts',
    );
  }

  // Top-level bound digests must agree with the target's receipt entry.
  if (targetReceipt.stage_contract_digest !== boundStageDigest) {
    fail(
      `input.stageContractDigest contradicts the integration receipt of slice "${sliceId}"`,
      'input.stageContractDigest',
    );
  }
  if (targetReceipt.slice_contract_digest !== boundSliceDigest) {
    fail(
      `input.sliceContractDigest contradicts the integration receipt of slice "${sliceId}"`,
      'input.sliceContractDigest',
    );
  }

  // ---- 1. stage contract current? (§8.5 INVALIDATED) ----
  if (binding.stage_contract_digest !== boundStageDigest) {
    return 'INVALIDATED';
  }

  // ---- 2. own slice contract current? (kernel oracle recompute) ----
  if (computeSliceContractDigest(manifest, sliceId) !== boundSliceDigest) {
    return 'STALE_CONTRACT';
  }

  // ---- 3. changed set over integrated slices + reverse dependency closure ----
  // changed = integrated slices whose CURRENT oracle digest differs from the
  // digest bound in their receipt (§10.5).
  const changed: string[] = [];
  for (const [id] of manifestSlices) {
    const receipt = receiptsBySlice.get(id);
    if (receipt === undefined) continue; // un-integrated: never "changed"
    if (computeSliceContractDigest(manifest, id) !== receipt.slice_contract_digest) {
      changed.push(id);
    }
  }
  const invalidated = computeReverseDependencyClosure(
    [...manifestSlices.values()],
    changed,
  );
  if (invalidated.includes(sliceId)) {
    return 'STALE_DEPENDENCY';
  }

  // ---- 4. direct dependency bindings current? ----
  // Every DECLARED dependency of the target slice must carry a receipt-bound
  // binding entry: a declared dependency without binding facts cannot be
  // proven current, so a missing/empty `dependencyBindings` input for a
  // slice with `depends_on` is STALE_DEPENDENCY (S12-D repair: it used to
  // fall through to CURRENT).
  const boundDepSlices = new Set(dependencyBindings.map((dep) => dep.slice_id));
  const targetDeclaredDeps = manifestSlices.get(sliceId)?.depends_on ?? [];
  for (const depId of targetDeclaredDeps) {
    if (!boundDepSlices.has(depId)) {
      return 'STALE_DEPENDENCY'; // declared dependency has no binding entry
    }
  }
  for (const dep of dependencyBindings) {
    const depSlice = manifestSlices.get(dep.slice_id);
    if (depSlice === undefined) {
      return 'STALE_DEPENDENCY'; // dependency disappeared from the manifest
    }
    if (computeSliceContractDigest(manifest, dep.slice_id) !== dep.slice_contract_digest) {
      return 'STALE_DEPENDENCY'; // dependency slice contract changed
    }
    const depReceipt = receiptsBySlice.get(dep.slice_id);
    if (depReceipt === undefined || depReceipt.receipt_digest !== dep.integration_receipt_digest) {
      return 'STALE_DEPENDENCY'; // dependency integration facts changed
    }
    if (depReceipt.integration_head_sha !== dep.integration_head_sha) {
      return 'STALE_DEPENDENCY'; // dependency integration HEAD moved
    }
  }

  return 'CURRENT';
}

/**
 * The §10.5 mechanical criterion: true iff the integrated slice is CURRENT
 * (stage/slice contract + dependency binding + integration receipt chain all
 * current). Pure and fail-closed; see `computeSliceCurrentness`.
 */
export function isIntegratedSliceCurrent(input: ComputeSliceCurrentnessInput): boolean {
  return computeSliceCurrentness(input) === 'CURRENT';
}
