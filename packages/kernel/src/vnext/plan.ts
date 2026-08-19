/**
 * @proofloop/kernel — vNext Canonical Plan model (S0-A, Slice 0.1).
 *
 * Defines the immutable vs mutable projection boundary and `plan_digest`.
 * checkbox / Worker Status / Current CV Status are execution projection and
 * never participate in `plan_digest`. Goal / refs / dependencies / Required
 * Skills / execution_scope are immutable and do participate.
 */

import {
  VNEXT_EXECUTION_SCOPE_KINDS,
  VNEXT_PLAN_KINDS,
  VNEXT_SCHEMA_VERSION,
} from './types';
import type {
  VNextCanonicalPlan,
  VNextExecutionScope,
  VNextPlanNode,
  VNextPlanProjection,
  VNextStageNodeProjection,
} from './types';
import { computeDigest } from './canonical';
import { SchemaValidationError } from '../validators';
import {
  collectErrors,
  checkUnknownFields,
  expectArray,
  expectNonEmptyString,
  expectObject,
  expectStringArray,
  type FieldError,
} from './internal';

const PLAN_KNOWN_FIELDS = new Set(['schema_version', 'items']);

const PLAN_ITEM_KNOWN_FIELDS = new Set([
  'id',
  'kind',
  'goal',
  'refs',
  'dependencies',
  'required_skills',
  'execution_scope',
  'checkbox',
  'status',
  'cv_status',
]);

const EXECUTION_SCOPE_KNOWN_FIELDS = new Set([
  'kind',
  'code_paths',
  'test_paths',
  'forbidden_paths',
]);

function isCanonicalRootRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    value.startsWith('/') ||
    value.startsWith('//') ||
    /^[A-Za-z]:(?:\/|$)/.test(value)
  ) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Validate one closed execution scope for use by Plan and Manifest seams. */
export function validateVNextExecutionScopeInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): VNextExecutionScope | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;

  checkUnknownFields(obj, EXECUTION_SCOPE_KNOWN_FIELDS, path, errors);

  const kind = obj.kind;
  if (
    typeof kind !== 'string' ||
    !(VNEXT_EXECUTION_SCOPE_KINDS as readonly string[]).includes(kind)
  ) {
    errors.push({
      path: `${path}.kind`,
      message: `Expected one of: ${VNEXT_EXECUTION_SCOPE_KINDS.map((item) => JSON.stringify(item)).join(', ')}`,
    });
  }

  const codePaths = expectStringArray(obj.code_paths, `${path}.code_paths`, errors, { unique: true });
  const testPaths = expectStringArray(obj.test_paths, `${path}.test_paths`, errors, { unique: true });
  const forbiddenPaths = expectStringArray(obj.forbidden_paths, `${path}.forbidden_paths`, errors, { unique: true });

  for (const [field, values] of [
    ['code_paths', codePaths],
    ['test_paths', testPaths],
    ['forbidden_paths', forbiddenPaths],
  ] as const) {
    if (!values) continue;
    for (const [index, item] of values.entries()) {
      if (!isCanonicalRootRelativePath(item)) {
        errors.push({
          path: `${path}.${field}[${index}]`,
          message: 'Expected a canonical root-relative path without absolute, dot-dot, backslash, or empty segments',
        });
      }
    }
  }

  if (kind === 'implementation') {
    if (codePaths !== undefined && codePaths.length === 0) {
      errors.push({ path: `${path}.code_paths`, message: 'implementation scope requires at least one code path' });
    }
    if (testPaths !== undefined && testPaths.length === 0) {
      errors.push({ path: `${path}.test_paths`, message: 'implementation scope requires at least one test path' });
    }
  }

  if (codePaths && testPaths && forbiddenPaths) {
    for (const allowed of [...codePaths, ...testPaths]) {
      for (const forbidden of forbiddenPaths) {
        if (pathsOverlap(allowed, forbidden)) {
          errors.push({
            path: `${path}.forbidden_paths`,
            message: `forbidden path "${forbidden}" overlaps executable path "${allowed}"`,
          });
        }
      }
    }
  }

  return obj as unknown as VNextExecutionScope;
}

function cloneExecutionScope(scope: VNextExecutionScope): VNextExecutionScope {
  return {
    kind: scope.kind,
    code_paths: [...scope.code_paths],
    test_paths: [...scope.test_paths],
    forbidden_paths: [...scope.forbidden_paths],
  };
}

/**
 * Extract the immutable Plan Projection of a Canonical Plan.
 *
 * Drops `checkbox`, `status` (Worker Status), and `cv_status` (Current CV
 * Status). Keeps `id`, `kind`, `goal`, `refs`, `dependencies`,
 * `required_skills`, `execution_scope`, and the schema version — the exact
 * `plan_digest` input.
 */
export function canonicalizePlanProjection(
  plan: VNextCanonicalPlan,
): VNextPlanProjection {
  const items = plan.items.map((item) => {
    const projection: VNextPlanProjection['items'][number] = {
      id: item.id,
      kind: item.kind,
      goal: item.goal,
      refs: [...item.refs],
      dependencies: [...item.dependencies],
      required_skills: [...item.required_skills],
    };
    if (item.execution_scope !== undefined) {
      projection.execution_scope = cloneExecutionScope(item.execution_scope);
    }
    return projection;
  });
  return { schema_version: plan.schema_version, items };
}

/**
 * Locate the single stage node of a Canonical Plan (fail-closed).
 *
 * A Canonical Plan must contain exactly one `stage` node; zero or multiple
 * stage nodes are rejected instead of guessing which node is authoritative.
 *
 * @throws {SchemaValidationError} when the plan has no stage node or more
 *   than one stage node.
 */
export function findStageNode(plan: VNextCanonicalPlan): VNextPlanNode {
  const stages = plan.items.filter((item) => item.kind === 'stage');
  if (stages.length === 0) {
    throw new SchemaValidationError(
      'VNextPlan: plan must contain exactly one stage node (found 0)',
      [{ path: 'plan.items', message: 'Expected exactly one stage node, found 0' }],
    );
  }
  if (stages.length > 1) {
    throw new SchemaValidationError(
      `VNextPlan: plan must contain exactly one stage node (found ${stages.length})`,
      [{ path: 'plan.items', message: `Expected exactly one stage node, found ${stages.length}` }],
    );
  }
  return stages[0];
}

/**
 * Extract the immutable projection of a Plan stage node.
 *
 * Keeps `id`, `kind`, `goal`, `refs`, `dependencies`, `required_skills` —
 * the exact `stage_node` input of the stage contract digest (§8.2). Drops
 * every mutable execution field (checkbox / status / cv_status).
 *
 * Array fields are deterministically sorted (copy, never mutates the input)
 * so that input ordering can never change the projection: `refs`,
 * `dependencies` and `required_skills` are SETS, not ordered lists, and the
 * digest must be order-independent (S12-B binding invariant).
 */
export function canonicalizeStageNodeProjection(
  node: VNextPlanNode,
): VNextStageNodeProjection {
  return {
    id: node.id,
    kind: node.kind,
    goal: node.goal,
    refs: [...node.refs].sort(),
    dependencies: [...node.dependencies].sort(),
    required_skills: [...node.required_skills].sort(),
  };
}

/**
 * Compute the deterministic `plan_digest` for a Canonical Plan.
 *
 * The digest covers ONLY the immutable projection — changing a checkbox or
 * Worker/CV status does NOT change the digest; changing a Goal, ref,
 * dependency, Required Skill, or execution scope DOES.
 */
export function computePlanDigest(plan: VNextCanonicalPlan): string {
  return computeDigest(canonicalizePlanProjection(plan));
}

function validatePlanNode(
  value: unknown,
  path: string,
  errors: FieldError[],
): void {
  const obj = expectObject(value, path, errors);
  if (!obj) return;

  checkUnknownFields(obj, PLAN_ITEM_KNOWN_FIELDS, path, errors);

  expectNonEmptyString(obj.id, `${path}.id`, errors);

  const kind = obj.kind;
  if (typeof kind !== 'string' || !(VNEXT_PLAN_KINDS as readonly string[]).includes(kind)) {
    errors.push({
      path: `${path}.kind`,
      message: `Expected one of: ${VNEXT_PLAN_KINDS.map((k) => JSON.stringify(k)).join(', ')}`,
    });
  }

  expectNonEmptyString(obj.goal, `${path}.goal`, errors);
  expectStringArray(obj.refs, `${path}.refs`, errors, { unique: true });
  expectStringArray(obj.dependencies, `${path}.dependencies`, errors, { unique: true });
  expectStringArray(obj.required_skills, `${path}.required_skills`, errors);

  if (kind === 'task') {
    validateVNextExecutionScopeInto(obj.execution_scope, `${path}.execution_scope`, errors);
  } else if (obj.execution_scope !== undefined) {
    errors.push({
      path: `${path}.execution_scope`,
      message: 'execution_scope is only allowed on task nodes',
    });
  }

  if (obj.checkbox !== undefined && typeof obj.checkbox !== 'boolean') {
    errors.push({ path: `${path}.checkbox`, message: 'Expected boolean' });
  }
  if (obj.status !== undefined && typeof obj.status !== 'string') {
    errors.push({ path: `${path}.status`, message: 'Expected string' });
  }
  if (obj.cv_status !== undefined && typeof obj.cv_status !== 'string') {
    errors.push({ path: `${path}.cv_status`, message: 'Expected string' });
  }
}

/**
 * Fail-closed validation of a vNext Canonical Plan.
 *
 * Rejects unknown fields, wrong schema version, empty ids/goals, invalid
 * kinds, and malformed optional status fields.
 *
 * @throws {SchemaValidationError} on any violation.
 */
export function validateVNextPlan(value: unknown): VNextCanonicalPlan {
  return collectErrors('VNextPlan', (errors) => {
    const obj = expectObject(value, 'plan', errors);
    if (!obj) return undefined;

    checkUnknownFields(obj, PLAN_KNOWN_FIELDS, 'plan', errors);

    if (obj.schema_version !== VNEXT_SCHEMA_VERSION) {
      errors.push({
        path: 'plan.schema_version',
        message: `Expected ${VNEXT_SCHEMA_VERSION}, got ${JSON.stringify(obj.schema_version)}`,
      });
    }

    const items = expectArray(obj.items, 'plan.items', errors);
    if (items) {
      for (let i = 0; i < items.length; i++) {
        validatePlanNode(items[i], `plan.items[${i}]`, errors);
      }
    }

    return obj as unknown as VNextCanonicalPlan;
  }) as VNextCanonicalPlan;
}
