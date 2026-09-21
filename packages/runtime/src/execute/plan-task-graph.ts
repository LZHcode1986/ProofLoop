/**
 * @proofloop/runtime — accepted Plan task-set / dependency graph capability
 * (S03-A-T01).
 *
 * Single producer of the `accepted_plan_task_graph` input that `task`-kind
 * MES facts must bind (contracts.md §5.1 / §2.2, mes.md write principle):
 *
 *   - `buildAcceptedPlanTaskGraph` derives, from the accepted Thin Plan
 *     OBJECT (current §4.1 shape) plus the exact accepted plan ref + plan
 *     digest, an OPQUE IN-MEMORY CAPABILITY minted only by this module with
 *     the module-private `PLAN_TASK_GRAPH_BRAND` symbol. Only this module
 *     mints the brand and registers the capability in a module-private
 *     WeakSet, so a plain JSON object, a deserialized shape, a caller-
 *     constructed object or a phantom graph with a matching digest can never
 *     pass the validator (brand/provenance single-producer boundary). The
 *     brand symbol property is NON-ENUMERABLE and the WeakSet registry is the
 *     authoritative identity check: a shallow-copy / structuredClone /
 *     copied-symbol clone is a DIFFERENT object that is NOT in the registry,
 *     so copying symbols onto a clone can never forge the brand
 *     (S03-STAGE-REVIEW-F001 closure). The minted capability and its nested
 *     task_ids / edges arrays (and edge objects) are deeply frozen, so the
 *     genuine graph and its nested content are immutable against caller
 *     mutation and any tampered clone fails closed before durable write;
 *   - `computeGraphDigest` implements the frozen formula
 *     `graph_digest = SHA-256(SPN({task_ids ascending, edges serialized
 *     sorted}))` (SPN = canonical JSON, keys sorted recursively, arrays in
 *     given order, UTF-8), so every graph is cryptographically bound to its
 *     task set and edge set;
 *   - the builder rejects non-canonical / duplicate task ids, malformed
 *     edges and downstream dependency cycles (fail closed, no partial
 *     graph); the `source` field is documentary only and is never a
 *     provenance basis;
 *     MES snapshot store forwards it to the binding validator
 *     (validateTaskFactGraphBinding) which re-checks brand, shape, ref /
 *     digest equality, digest recomputation, exact dependency edge-set
 *     equality and blocked_by containment BEFORE any durable write.
 *
 * No MES reasoning, no route, no second state machine (STATIC-05/14).
 */
import * as crypto from 'node:crypto';
import { canonicalStringify } from '../cli/proofloop-common';
import { MES_TASK_ID_RE } from '../mes/types';

/**
 * Module-level brand symbol. NEVER exported and installed on the minted
 * capability as a NON-ENUMERABLE property: spread / JSON.deserialize /
 * structuredClone never carry it, and re-attaching the extracted symbol to a
 * clone still fails the authoritative WeakSet identity check below.
 */
const PLAN_TASK_GRAPH_BRAND: unique symbol = Symbol('PLAN_TASK_GRAPH_BRAND');

/**
 * Module-private registry of builder-minted capabilities (weak references,
 * never leaked). The ONLY way a value passes `isAcceptedPlanTaskGraph` is to
 * BE one of the exact object identities minted by `buildAcceptedPlanTaskGraph`: a
 * spread / structuredClone / copied-symbol clone, a deserialized shape or a
 * caller-constructed object is a different object and is never in the
 * registry (S03-STAGE-REVIEW-F001: brand cannot be forged by copying symbols
 * onto a clone).
 */
const mintedGraphCapabilities = new WeakSet<object>();

/**
 * Brand-provenance check (the ONLY way to verify a capability): the value
 * must be one of the exact object identities minted by this module. Plain JSON,
 * deserialized shapes, caller-constructed objects, phantom graphs with a
 * matching digest and ANY clone (shallow, structured, symbol-copied) fail
 * closed.
 */
export function isAcceptedPlanTaskGraph(value: unknown): value is AcceptedPlanTaskGraph {
  return isObject(value) && mintedGraphCapabilities.has(value);
}
/** Closed edge kinds the graph shape allows. */
export type PlanGraphEdgeKind = 'dependency' | 'blocked_by';

/** A directed edge of the accepted Plan task graph. */
export interface PlanGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: PlanGraphEdgeKind;
}

/**
 * Opaque in-memory capability minted ONLY by `buildAcceptedPlanTaskGraph`
 * and registered in the module-private WeakSet. Carries the non-enumerable
 * brand symbol and is deeply frozen; plain JSON / deserialized / caller-built
 * shapes and any clone (spread / structured / symbol-copied) are never in
 * the registry and fail closed at the validator.
 */
export interface AcceptedPlanTaskGraph {
  readonly [PLAN_TASK_GRAPH_BRAND]: true;
  readonly accepted_plan_ref: string;
  readonly accepted_plan_digest: string;
  readonly graph_digest: string;
  readonly task_ids: readonly string[];
  readonly edges: readonly PlanGraphEdge[];
  /** Documentary only — never a provenance basis. */
  readonly source: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function graphFail(message: string): never {
  throw new Error(`accepted_plan_task_graph construction failed: ${message}`);
}

/**
 * Canonical edge serialization: each edge as {kind, from, to}, sorted
 * lexicographically by kind then from then to. Arrays keep element order
 * inside canonicalStringify, so sorting here makes the serialization
 * order-independent (part of the frozen digest formula).
 */
export function serializeEdges(edges: readonly PlanGraphEdge[]): string {
  const sorted = edges
    .map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to }))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    );
  return canonicalStringify(sorted);
}

/**
 * Frozen graph digest formula:
 * `graph_digest = SHA-256(SPN({task_ids ascending, edges serialized sorted}))`.
 */
export function computeGraphDigest(
  taskIds: readonly string[],
  edges: readonly PlanGraphEdge[],
): string {
  const canonical = canonicalStringify({
    task_ids: [...taskIds].sort(),
    edges: serializeEdges(edges),
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function expectCanonicalTaskId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !MES_TASK_ID_RE.test(value)) {
    graphFail(`${label} must be a canonical task id matching /^S\\d+-[A-Z]+-T\\d+$/`);
  }
  return value;
}

/**
 * Derive the task set + dependency/blocked edge set from the accepted Thin
 * Plan object (current §4.1 shape: `slices[].tasks[].task` with
 * `dependencies: string[]`). The result is the opaque brand-bound capability.
 *
 * @throws {Error} on non-canonical task ids, duplicate task ids, malformed
 *   edges or a downstream dependency cycle (fail closed, never partial).
 */
export function buildAcceptedPlanTaskGraph(
  plan: unknown,
  acceptedPlanRef: string,
  acceptedPlanDigest: string,
): AcceptedPlanTaskGraph {
  if (!isObject(plan) || !Array.isArray(plan.slices)) {
    graphFail('accepted Thin Plan must be an object with a slices array');
  }
  if (typeof acceptedPlanRef !== 'string' || acceptedPlanRef.length === 0) {
    graphFail('accepted_plan_ref must be a non-empty string');
  }
  if (typeof acceptedPlanDigest !== 'string' || !/^[0-9a-f]{64}$/.test(acceptedPlanDigest)) {
    graphFail('accepted_plan_digest must be a 64-char lowercase hex SHA-256 digest');
  }

  const taskIds: string[] = [];
  const edges: PlanGraphEdge[] = [];
  const seen = new Set<string>();

  for (const slice of plan.slices) {
    if (!isObject(slice) || !Array.isArray(slice.tasks)) {
      graphFail('every plan slice must be an object with a tasks array');
    }
    for (const task of slice.tasks) {
      if (!isObject(task)) {
        graphFail('every plan task must be an object with a canonical task id');
      }
      const taskId = expectCanonicalTaskId(task.task, 'plan task id');
      if (seen.has(taskId)) {
        graphFail(`duplicate task id ${JSON.stringify(taskId)} in the accepted plan`);
      }
      seen.add(taskId);
      taskIds.push(taskId);

      const dependencies = task.dependencies;
      if (dependencies !== undefined) {
        if (!Array.isArray(dependencies)) {
          graphFail(`task ${taskId} dependencies must be an array of canonical task ids`);
        }
        for (const dep of dependencies) {
          edges.push({
            from: taskId,
            to: expectCanonicalTaskId(dep, `task ${taskId} dependency`),
            kind: 'dependency',
          });
        }
      }
      const blockedBy = task.blocked_by;
      if (blockedBy !== undefined) {
        if (!Array.isArray(blockedBy)) {
          graphFail(`task ${taskId} blocked_by must be an array of canonical task ids`);
        }
        // Blocked_by closure (CV-S03-A-R2): a blocked_by entry MUST be a real
        // accepted-plan dependency of the SAME task — contracts.md §5.1 only
        // records blocked_by on real dependency descendants. A declared but
        // non-dependency target (dependencies=[] with blocked_by=[X]) must
        // fail closed at construction.
        const depList = Array.isArray(dependencies) ? (dependencies as unknown[]) : [];
        for (const blocker of blockedBy) {
          const blockerId = expectCanonicalTaskId(blocker, `task ${taskId} blocked_by`);
          if (!depList.includes(blockerId)) {
            graphFail(`blocked_by ${blockerId} of task ${taskId} is not a real accepted-plan dependency of ${taskId}`);
          }
          edges.push({
            from: taskId,
            to: blockerId,
            kind: 'blocked_by',
          });
        }
      }
    }
  }

  // Downstream dependency-cycle rejection (fail closed): a cycle would make
  // the dependency closure non-well-founded for successor barriers.
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'dependency') continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      graphFail(`downstream dependency cycle detected involving ${JSON.stringify(node)}`);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of taskIds) visit(node);

  // Edge closure (fail closed): every edge must be anchored in the accepted
  // plan task set — a dangling dependency / blocked_by target (a task id that
  // is not itself a task of the accepted plan) would otherwise smuggle an
  // undeclared task into the graph.
  const taskSet = new Set<string>(taskIds);
  for (const edge of edges) {
    if (!taskSet.has(edge.from) || !taskSet.has(edge.to)) {
      graphFail(`edge ${edge.kind} ${edge.from} -> ${edge.to} references a task id outside the accepted plan task set (dangling edge)`);
    }
  }

  // Deep-freeze the capability and ALL nested structure BEFORE minting:
  // the genuine graph and its nested task_ids / edges (and edge objects) are
  // immutable against caller mutation — an in-place mutation attempt throws
  // (strict mode) or is a silent no-op, and a tampered clone is a different
  // object identity that is never in the registry (fail closed).
  for (const edge of edges) Object.freeze(edge);
  Object.freeze(taskIds);
  Object.freeze(edges);

  const graph = {
    accepted_plan_ref: acceptedPlanRef,
    accepted_plan_digest: acceptedPlanDigest,
    graph_digest: computeGraphDigest(taskIds, edges),
    task_ids: taskIds,
    edges,
    source: 'packages/runtime/src/execute/plan-task-graph.ts@buildAcceptedPlanTaskGraph',
  } as unknown as AcceptedPlanTaskGraph;
  // Non-enumerable brand: spread / JSON.deserialize / structuredClone can
  // never copy it; Object.getOwnPropertySymbols extraction is defeated by
  // the WeakSet identity registry deciding provenance.
  Object.defineProperty(graph, PLAN_TASK_GRAPH_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(graph);
  mintedGraphCapabilities.add(graph);
  return graph;
}
