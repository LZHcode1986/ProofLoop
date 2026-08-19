/**
 * proofloop-common.ts — S10-A-T01: shared helpers for the public proofloop CLI
 * seam base.
 *
 * Provides the closed domain/operation registry (§0.3), the canonical JSON
 * result envelope (§0.2), the exit contract (§0.1) and the canonical trust
 * root assertion.  This module never writes Receipts/Manifest/Context/
 * Evidence and never imports a harness SDK (OpenCode/Pi/Claude); it only
 * consumes Node built-ins and the runtime's own root-bound helpers.
 *
 * S10-A-T02 registers the doctor domain handlers; later Slices register the
 * authority/plan/context/stage/review/project handlers through the
 * same closed registry.  The registry is the single closed command matrix —
 * unknown domain/operation must fail closed before any write or input read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveProjectRoot } from './vnext-cli-support-vnext';
import { canonicalPathWithinRoot } from '../path-guard';
import { readRootBoundFile } from '../vnext';

// ============================================================
// Version / schema
// ============================================================

export const PROOFLOOP_CLI_SCHEMA_VERSION = 2;

/**
 * Runtime package version, read from `packages/runtime/package.json` so the
 * built dist CLI and the source tests report the same value (source/dist
 * 同构, §0.2 runtime.version).
 */
function readRuntimeVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const PROOFLOOP_RUNTIME_VERSION: string = readRuntimeVersion();

/** Environment variable that may carry the explicit trust root. */
export const PROOFLOOP_ROOT_ENV = 'PROOFLOOP_ROOT';

// ============================================================
// Exit contract (§0.1 + S10-A-T01 design)
// ============================================================

export const CLI_EXIT = {
  /** 0 = command completed / accepted / read-ready. */
  OK: 0,
  /** 1 = usage / schema / runtime failure, no-write. */
  USAGE: 1,
  /** 2 = structured blocked / refused / no-write. */
  BLOCKED: 2,
} as const;

// ============================================================
// Closed domain/operation registry (§0.3 closed command matrix)
// ============================================================

export const CANONICAL_DOMAINS = [
  'authority',
  'plan',
  'context',
  'stage',
  'review',
  'project',
  'doctor',
  'gate',
  'recovery',
  // S10-E-T02 repair: cutover 域接入唯一 public seam（CLI Contract §0.3）。
  'cutover',
] as const;

export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

export interface DomainRegistryEntry {
  readonly domain: CanonicalDomain;
  readonly operations: readonly string[];
}

export const DOMAIN_REGISTRY: Readonly<Record<CanonicalDomain, DomainRegistryEntry>> = {
  authority: { domain: 'authority', operations: ['check'] },
  plan: {
    domain: 'plan',
    operations: [
      'materialize',
      'compile',
      'validate',
      'initialize-evidence',
      'refresh-evidence',
      'status',
      'admit-spv',
      'admit-stage-plan',
    ],
  },
  context: {
    domain: 'context',
    operations: ['prepare', 'show', 'admit-refutation-observation'],
  },
  stage: {
    domain: 'stage',
    operations: [
      'status',
      'next',
      'admit-worker',
      'admit-cv',
      'admit-slice-commit',
      'admit-integration',
      'run-gate',
      // P-11: vNext Stage Close admission 的 public CLI 入口（write-once
      // STAGE_CLOSE_PASS receipt）。
      'close',
    ],
  },
  review: { domain: 'review', operations: ['status', 'prepare-stage', 'finalize-stage'] },
  project: {
    domain: 'project',
    operations: [
      'status',
      'compile-acceptance',
      'run-e2e',
      'prepare-review',
      'finalize-review',
    ],
  },
  // S10-D-T03: doctor 域补 run/status 闭集完整语义（status 只读状态报告 +
  // receipts 类别摘要）。
  doctor: { domain: 'doctor', operations: ['run', 'status'] },
  gate: { domain: 'gate', operations: ['run', 'status'] },
  // S10-D-T03: recovery 域 closed 操作集（check/preflight/restart/doctor）。
  recovery: {
    domain: 'recovery',
    operations: ['check', 'preflight', 'restart', 'doctor'],
  },
  // S10-E-T02 repair: cutover 域 closed 操作集（status 只读 legacy scan；
  // execute 带 irreversible 保护语义的删除执行）。
  cutover: { domain: 'cutover', operations: ['status', 'execute'] },
};

export function isCanonicalDomain(value: string): value is CanonicalDomain {
  return (CANONICAL_DOMAINS as readonly string[]).includes(value);
}

export function isCanonicalOperation(domain: CanonicalDomain, operation: string): boolean {
  return DOMAIN_REGISTRY[domain].operations.includes(operation);
}

// ============================================================
// Canonical CLI result envelope (§0.2)
// ============================================================

export interface CliCommand {
  readonly domain: string | null;
  readonly operation: string | null;
}

export interface CliFinding {
  readonly code: string;
  readonly message: string;
}

export interface CliRef {
  readonly ref: string;
  readonly digest: string;
}

export interface CliEnvelope {
  readonly schema_version: 2;
  readonly ok: boolean;
  readonly command: CliCommand;
  readonly result: unknown;
  readonly findings: readonly CliFinding[];
  readonly refs: readonly CliRef[];
  readonly runtime: {
    readonly version: string;
    readonly schema_version: number;
  };
}

function baseEnvelope(command: CliCommand): Omit<CliEnvelope, 'ok' | 'result' | 'findings'> {
  return {
    schema_version: PROOFLOOP_CLI_SCHEMA_VERSION,
    command,
    refs: [],
    runtime: {
      version: PROOFLOOP_RUNTIME_VERSION,
      schema_version: PROOFLOOP_CLI_SCHEMA_VERSION,
    },
  };
}

export function okEnvelope(command: CliCommand, result: unknown): CliEnvelope {
  return { ...baseEnvelope(command), ok: true, result, findings: [] };
}

/** S10-B-T01: ok envelope carrying operation ref+digest bindings (e.g. a written Manifest). */
export function okEnvelopeWithRefs(
  command: CliCommand,
  result: unknown,
  refs: readonly CliRef[],
): CliEnvelope {
  return { ...baseEnvelope(command), ok: true, result, findings: [], refs: [...refs] };
}

export function errorEnvelope(command: CliCommand, code: string, message: string): CliEnvelope {
  return {
    ...baseEnvelope(command),
    ok: false,
    result: null,
    findings: [{ code, message }],
  };
}

/** S10-B-T01: blocked envelope carrying every structured finding from a seam result. */
export function failureEnvelope(
  command: CliCommand,
  findings: readonly CliFinding[],
): CliEnvelope {
  return { ...baseEnvelope(command), ok: false, result: null, findings: [...findings] };
}

/**
 * Canonical JSON serialization (CV repair): recursively sorts object keys so
 * that logically equal envelopes produce byte-identical stdout regardless of
 * property insertion order; arrays keep element order; `undefined` values are
 * dropped (JSON semantics).  Output is a single line of canonical JSON.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = sortKeys(entry);
    }
    return sorted;
  }
  return value;
}

/** stdout must carry exactly one canonical JSON envelope line (§0.1). */
export function emitEnvelope(envelope: CliEnvelope): void {
  console.log(canonicalStringify(envelope));
}

// ============================================================
// Canonical trust root assertion
// ============================================================

export interface TrustRootResolution {
  readonly root: string;
  readonly source: 'explicit' | 'auto';
}

export class TrustRootError extends Error {
  readonly code: 'RUNTIME.PROJECT_ROOT_NOT_RESOLVED' | 'RUNTIME.PROJECT_ROOT_MISMATCH';
  constructor(
    code: 'RUNTIME.PROJECT_ROOT_NOT_RESOLVED' | 'RUNTIME.PROJECT_ROOT_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'TrustRootError';
    this.code = code;
  }
}

function hasMarkerDir(root: string, marker: string): boolean {
  const candidate = path.join(root, marker);
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk upward from `start` to the nearest ancestor carrying a `.proofloop`
 * or `.git` directory marker.  `process.cwd()` is never trusted by itself:
 * a canonical trust root must be anchored by an artifact/git marker or by an
 * explicit `--project-root` / `PROOFLOOP_ROOT`.
 */
function findProjectRootUpward(start: string): string | null {
  let current: string;
  try {
    current = fs.realpathSync(start);
  } catch {
    return null;
  }
  for (;;) {
    if (hasMarkerDir(current, '.proofloop') || hasMarkerDir(current, '.git')) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the canonical trust root:
 *  - explicit root (`--project-root` / `--root` flag or `PROOFLOOP_ROOT`
 *    env): must be an existing directory (realpath-canonicalized); when the
 *    cwd also auto-resolves to a different root, the explicit root fails
 *    closed (§0.1: caller-provided project_root is a consistency assertion,
 *    never an override of the canonical root).
 *  - otherwise: nearest ancestor of cwd carrying `.proofloop` or `.git`.
 *  - no root resolvable → `TrustRootError` (fail closed; cwd alone is never
 *    an artifact trust root).
 */
export function resolveTrustRoot(
  options: { readonly explicitRoot?: string; readonly cwd?: string } = {},
): TrustRootResolution {
  const cwd = options.cwd ?? process.cwd();
  const autoRoot = findProjectRootUpward(cwd);
  if (options.explicitRoot !== undefined) {
    let canonical: string;
    try {
      canonical = resolveProjectRoot(options.explicitRoot);
    } catch (error) {
      throw new TrustRootError(
        'RUNTIME.PROJECT_ROOT_NOT_RESOLVED',
        `explicit project root is not a valid trust root: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (autoRoot !== null && autoRoot !== canonical) {
      throw new TrustRootError(
        'RUNTIME.PROJECT_ROOT_MISMATCH',
        `explicit project root "${canonical}" conflicts with the auto-resolved canonical trust root "${autoRoot}"`,
      );
    }
    return { root: canonical, source: 'explicit' };
  }
  if (autoRoot === null) {
    throw new TrustRootError(
      'RUNTIME.PROJECT_ROOT_NOT_RESOLVED',
      `cannot resolve a canonical trust root from cwd "${cwd}" (no .proofloop/.git marker found; pass --project-root or set ${PROOFLOOP_ROOT_ENV})`,
    );
  }
  return { root: autoRoot, source: 'auto' };
}

// ============================================================
// Closed argv parsing
// ============================================================

export interface ParsedCliArgs {
  readonly positionals: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
  /** `--project-root` (canonical, §0.1) or `--root` (S10-A-T01 alias). */
  readonly projectRoot: string | undefined;
  /** `--request <root-relative-json>` — root-bound/no-follow request file (S10-A-T02). */
  readonly requestPath: string | undefined;
  /**
   * `--json` (S10-A-T02): optional-value flag — `--json <closed-json>` is the
   * inline closed input; a bare `--json` (no value) is the JSON output mode
   * declaration and leaves `jsonInput` undefined.
   */
  readonly jsonInput: string | undefined;
  /**
   * `--stage <stage-id>` (S10-B-T01): target Stage ID for the plan/authority
   * domain operations (`plan validate --json --stage S10`).  A canonical
   * Stage ID (`^S\d+$`) is enforced by the domain handler; the flag itself is
   * closed but generic so the dispatcher can surface it to any domain.
   */
  readonly stage: string | undefined;
  /**
   * S10-B-T02 context-domain flags: `--role <role>` (closed Context role
   * set), `--slice <slice-id>` / `--task <task-id>` (Context tuple bindings),
   * `--observation <text>` (admit-refutation-observation input),
   * `--observation-ref <root-relative-ref>` (show gate verification: the
   * digest-addressed persisted observation record) and `--ref
   * <root-relative-context-ref>` (show read-back mode).  All are closed
   * generic value flags; only the context handler consumes them.
   */
  readonly role: string | undefined;
  readonly slice: string | undefined;
  readonly task: string | undefined;
  readonly observation: string | undefined;
  readonly observationRef: string | undefined;
  readonly ref: string | undefined;
}

const VALUE_FLAGS = new Set([
  '--project-root',
  '--root',
  '--request',
  '--stage',
  '--role',
  '--slice',
  '--task',
  '--observation',
  '--observation-ref',
  '--ref',
]);
const BOOLEAN_FLAGS = new Set(['--help', '--version']);

/**
 * Parse the closed flag set only.  Unknown flags / missing values throw; the
 * dispatcher maps that to the USAGE exit (1) with a canonical envelope.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const positionals: string[] = [];
  let help = false;
  let version = false;
  let projectRoot: string | undefined;
  let requestPath: string | undefined;
  let jsonInput: string | undefined;
  let stage: string | undefined;
  let role: string | undefined;
  let slice: string | undefined;
  let task: string | undefined;
  let observation: string | undefined;
  let observationRef: string | undefined;
  let ref: string | undefined;

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const flag = equals === -1 ? token : token.slice(0, equals);
      if (BOOLEAN_FLAGS.has(flag)) {
        if (equals !== -1) {
          throw new Error(`flag "${flag}" does not take a value`);
        }
        if (flag === '--help') help = true;
        if (flag === '--version') version = true;
        index += 1;
        continue;
      }
      if (VALUE_FLAGS.has(flag)) {
        let value: string | undefined;
        if (equals !== -1) {
          value = token.slice(equals + 1);
          index += 1;
        } else {
          value = argv[index + 1];
          index += 2;
        }
        if (value === undefined || value.length === 0) {
          throw new Error(`flag "${flag}" requires a value`);
        }
        if (flag === '--project-root' || flag === '--root') projectRoot = value;
        if (flag === '--request') requestPath = value;
        if (flag === '--stage') stage = value;
        if (flag === '--role') role = value;
        if (flag === '--slice') slice = value;
        if (flag === '--task') task = value;
        if (flag === '--observation') observation = value;
        if (flag === '--observation-ref') observationRef = value;
        if (flag === '--ref') ref = value;
        continue;
      }
      if (flag === '--json') {
        // Optional-value flag (§0.1): `--json <closed-json>` inline input, or
        // a bare `--json` declaring JSON output mode (no input value).
        if (equals !== -1) {
          jsonInput = token.slice(equals + 1);
          index += 1;
        } else {
          const next = argv[index + 1];
          if (next !== undefined && !next.startsWith('--')) {
            jsonInput = next;
            index += 2;
          } else {
            index += 1;
          }
        }
        continue;
      }
      throw new Error(`unknown flag "${flag}"`);
    }
    positionals.push(token);
    index += 1;
  }

  return {
    positionals,
    help,
    version,
    projectRoot,
    requestPath,
    jsonInput,
    stage,
    role,
    slice,
    task,
    observation,
    observationRef,
    ref,
  };
}

// ============================================================
// Closed request input (§0.1: closed JSON object, unknown field fail
// closed; `--request` must be root-bound/no-follow)
// ============================================================

/**
 * Closed request schema fields (S10-A-T02): domain/operation consistency.
 * S10-B-T01 extends the schema per domain so plan/authority operations can
 * carry their bounded parameters through the same unified request contract
 * (`--request` file or `--json` inline).  Unknown fields still fail closed.
 */
export interface CliRequestInput {
  readonly domain: string | undefined;
  readonly operation: string | undefined;
  /** S10-B-T01: target canonical Stage ID (`^S\d+$`) for plan/authority ops. */
  readonly stage: string | undefined;
  /** S10-B-T01: root-relative vNext Manifest path (default `.proofloop/manifests/<stage>.json`). */
  readonly manifest: string | undefined;
  /** S10-B-T01: previous Manifest digest for `plan refresh-evidence`. */
  readonly previous_manifest_digest: string | undefined;
  /** S10-B-T01: explicit evidence directory (default derived from the Manifest). */
  readonly evidence_dir: string | undefined;
  /** S10-B-T01: refresh transaction mode (refresh | recover | rollback). */
  readonly mode: string | undefined;
  /**
   * S15-A-T02 (optional superset, same precedent as the project-domain
   * fields): mode=replan — root-relative, digest-addressed Runtime
   * preparation disposition fact ref (`.proofloop/runtime/replan/**`),
   * its content digest and the rotation transaction phase
   * (rotate | recover | rollback).  Optional so existing `CliRequestInput`
   * literals outside the plan domain stay valid; the closed schema
   * validation below enforces the mode=replan tuple.
   */
  readonly disposition_ref?: string | undefined;
  readonly disposition_digest?: string | undefined;
  readonly replan_phase?: string | undefined;
  /** S10-B-T01: root-relative candidate input path for `plan compile`. */
  readonly input_path: string | undefined;
  /** S10-B-T01: root-relative Manifest output path for `plan compile`. */
  readonly output_path: string | undefined;
  /**
   * S10-B-T02 context-domain fields: closed Context role (`prepare`/`show`),
   * slice/task tuple bindings, `admit-refutation-observation` text and the
   * show-mode `observation_ref` / `ref` inputs.
   */
  readonly role: string | undefined;
  readonly slice: string | undefined;
  readonly task: string | undefined;
  readonly observation: string | undefined;
  readonly observation_ref: string | undefined;
  readonly ref: string | undefined;
  /**
   * S10-D-T02 project-domain fields: root-relative manifest path
   * (`run-e2e`/`prepare-review`/`finalize-review`), root-relative Project E2E
   * Gate Receipt path (`prepare-review`/`finalize-review`), root-relative AI
   * Project Reviewer result file path (`finalize-review`) and the optional
   * root-relative Receipt output directory (`run-e2e`/`finalize-review`;
   * default canonical `project/` category).  Optional so existing
   * `CliRequestInput` literals outside the project domain stay valid.
   */
  readonly manifest_path?: string | undefined;
  readonly e2e_receipt_path?: string | undefined;
  readonly reviewer_result_path?: string | undefined;
  readonly output_dir?: string | undefined;
}

/**
 * S10-C-T01 stage-domain extension of the closed request contract（超集，
 * 不修改既有 CliRequestInput，避免波及 scope 外构造点）：
 * `envelope` 携带 closed vNext structured-result 对象（Worker v2 envelope /
 * CV_RESULT envelope）；`verdict` / `snapshot_digest` / `summary` 是 legacy CV
 * scalars（vNext CLI 拒绝，cross-version fail closed）；`commit_sha` /
 * `cv_receipt_digest` 绑定 Slice Commit。
 */
export interface StageCliRequestInput extends CliRequestInput {
  readonly envelope: unknown;
  readonly verdict: string | undefined;
  readonly snapshot_digest: string | undefined;
  readonly summary: string | undefined;
  readonly commit_sha: string | undefined;
  readonly cv_receipt_digest: string | undefined;
  /** P-11 stage close: closed close_type（full | restricted）。 */
  readonly close_type: string | undefined;
  /** P-11 stage close: 非空 close reason（fail-closed）。 */
  readonly reason: string | undefined;
  /** P-11 stage close: Manifest digest（sha256；seam 重验与 persisted Manifest 一致）。 */
  readonly manifest_digest: string | undefined;
}

export type CliRequestValidation =
  | { readonly ok: true; readonly request: StageCliRequestInput }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Closed request field set per domain (S10-B-T01); other domains stay closed to {domain, operation}. */
const REQUEST_KNOWN_FIELDS_BY_DOMAIN: Readonly<Record<string, ReadonlySet<string>>> = {
  authority: new Set(['domain', 'operation', 'stage', 'manifest']),
  // A1 step 5: plan 域 closed request 字段 — materialize 追加 check
  // （boolean，只复核不写 → CANDIDATE_CHECKED）。check 的类型特例见
  // parseClosedRequestObject。未知字段仍 fail closed。
  plan: new Set([
    'domain',
    'operation',
    'stage',
    'manifest',
    'previous_manifest_digest',
    'evidence_dir',
    'mode',
    'disposition_ref',
    'disposition_digest',
    'replan_phase',
    'input_path',
    'output_path',
    'check',
  ]),
  context: new Set([
    'domain',
    'operation',
    'stage',
    'role',
    'slice',
    'task',
    'observation',
    'observation_ref',
    'ref',
  ]),
  stage: new Set([
    'domain',
    'operation',
    'stage',
    'slice',
    'envelope',
    'verdict',
    'snapshot_digest',
    'summary',
    'commit_sha',
    'cv_receipt_digest',
    // P-11: stage close closed 字段 — close_type（full|restricted）、非空
    // reason 与 manifest_digest（sha256，admit seam 重验）。plan_digest /
    // stage_plan_receipt_digest / spv_receipt_digest 由 seam 从 root-bound
    // authority 重读派生，caller 不可注入（未登记 → 未知字段 fail closed）。
    'close_type',
    'reason',
    'manifest_digest',
  ]),
  // S10-D-T01: review 域 closed request 字段 — status/prepare-stage 只需
  // `stage`；finalize-stage 追加 closed verdict（ACCEPTED|REPAIR）与非空
  // summary（与 Host proofloop_review 对齐）。未知字段仍 fail closed。
  review: new Set(['domain', 'operation', 'stage', 'verdict', 'summary']),
  // S10-D-T02: project 域 closed request 字段 — status 只需 domain/operation
  // （project 域全局，无 --stage）；compile-acceptance 用 input_path +
  // output_path；run-e2e/prepare-review/finalize-review 用 manifest_path；
  // prepare-review/finalize-review 追加 e2e_receipt_path；finalize-review
  // 追加 reviewer_result_path + closed verdict（PROJECT_ACCEPTED|
  // PROJECT_REJECTED|PROJECT_BLOCKED）+ 非空 summary；run-e2e/finalize-review
  // 可选 output_dir。未知字段仍 fail closed。
  project: new Set([
    'domain',
    'operation',
    'input_path',
    'output_path',
    'manifest_path',
    'e2e_receipt_path',
    'reviewer_result_path',
    'output_dir',
    'verdict',
    'summary',
  ]),
  // S10-SR-001 repair: gate 域 closed request 字段 — run/status 需要 canonical
  // stage；run 可选 verification_source（dual-path SG 的显式验证路径声明：
  // receipts 默认 | git_facts 显式兜底，非法值在 parseClosedRequestObject
  // fail-closed）。P-09：run 可选 re_gate（boolean，REPAIR 驱动重跑声明）。
  // 未知字段仍 fail closed。
  gate: new Set(['domain', 'operation', 'stage', 'verification_source', 're_gate']),
  // S10-D-T03: recovery 域 closed request 字段 — check/preflight/restart
  // 需要 canonical stage（--stage 或 request stage，一致性由
  // resolveRequestInput 保证）；doctor 转发 doctor 域无需额外字段。
  // 未知字段仍 fail closed。
  recovery: new Set(['domain', 'operation', 'stage']),
  // S10-E-T02 repair: cutover 域 closed request 字段 — status 只读无需额外
  // 字段；execute 需要 canonical stage（Acceptance A–E 事实验证目标）、
  // confirmed（boolean，irreversible 确认）与 delete_list（string[]，
  // 必须与 cutover status 检测出的 legacy 删除目标完全一致）。未知字段
  // 仍 fail closed。confirmed/delete_list 的类型特例见 parseClosedRequestObject。
  cutover: new Set(['domain', 'operation', 'stage', 'confirmed', 'delete_list']),
};

const REQUEST_BASE_FIELDS = new Set(['domain', 'operation']);

function parseClosedRequestObject(value: unknown, domain: string): CliRequestValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: 'request input must be a closed JSON object',
    };
  }
  const record = value as Record<string, unknown>;
  const known = REQUEST_KNOWN_FIELDS_BY_DOMAIN[domain] ?? REQUEST_BASE_FIELDS;
  const unknownFields = Object.keys(record).filter((key) => !known.has(key));
  if (unknownFields.length > 0) {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: `unknown field(s) in request input for domain "${domain}": ${unknownFields.join(', ')} (closed schema: ${[...known].join(', ')})`,
    };
  }
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) continue;
    // S10-C-T01: the stage-domain `envelope` is the closed structured-result
    // object (vNext Worker envelope / CV_RESULT envelope); every other field
    // stays a string.
    if (key === 'envelope') {
      if (typeof record[key] !== 'object' || record[key] === null || Array.isArray(record[key])) {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: 'request field "envelope" must be a JSON object (closed structured result)',
        };
      }
      continue;
    }
    // S10-E-T02 repair: the cutover-domain `confirmed` is the irreversible
    // acknowledgement boolean and `delete_list` is the closed string-array of
    // legacy delete targets.  Only the cutover domain registers these keys
    // (unknown-field rejection above keeps them out of every other domain).
    if (key === 'confirmed') {
      if (typeof record[key] !== 'boolean') {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: 'request field "confirmed" must be a boolean (irreversible cutover acknowledgement)',
        };
      }
      continue;
    }
    if (key === 'delete_list') {
      if (
        !Array.isArray(record[key]) ||
        record[key].some((entry) => typeof entry !== 'string' || entry.length === 0)
      ) {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: 'request field "delete_list" must be an array of non-empty root-relative path strings',
        };
      }
      continue;
    }
    // S10-SR-001 repair: the gate-domain `verification_source` is the closed
    // enum declaring the explicit dual-path Gate verification path
    // (`receipts` normal path | `git_facts` explicit fallback).  Only the
    // gate domain registers this key (unknown-field rejection above keeps it
    // out of every other domain); an illegal value fails closed before any
    // handler runs.
    if (key === 'verification_source') {
      if (record[key] !== 'receipts' && record[key] !== 'git_facts') {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: `request field "verification_source" must be "receipts" or "git_facts", received "${String(record[key])}"`,
        };
      }
      continue;
    }
    // P-09: the gate-domain `re_gate` is the explicit REPAIR-driven re-run
    // declaration (boolean).  Only the gate domain registers this key; a
    // non-boolean value fails closed before any handler runs.
    if (key === 're_gate') {
      if (typeof record[key] !== 'boolean') {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: 'request field "re_gate" must be a boolean (explicit REPAIR-driven re-gate declaration)',
        };
      }
      continue;
    }
    // A1 step 5: the plan-domain `check` is the read-only materialize recheck
    // declaration (boolean → CANDIDATE_CHECKED, zero writes).  Only the plan
    // domain registers this key (unknown-field rejection above keeps it out
    // of every other domain); a non-boolean value fails closed before any
    // handler runs.
    if (key === 'check') {
      if (typeof record[key] !== 'boolean') {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: 'request field "check" must be a boolean (read-only materialize recheck declaration)',
        };
      }
      continue;
    }
    // S15-A-T02: the plan-domain `disposition_digest` is the content digest
    // of the Runtime preparation disposition fact (mode=replan); a malformed
    // digest fails closed before any handler runs.  The `replan_phase` field
    // is the closed rotation phase enum (rotate | recover | rollback) and is
    // only legal together with mode=replan; mode=replan itself requires the
    // disposition ref/digest.  Only the plan domain registers these keys.
    if (key === 'disposition_digest') {
      if (typeof record[key] !== 'string' || !/^[a-f0-9]{64}$/.test(record[key] as string)) {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: 'request field "disposition_digest" must be a lowercase SHA-256 (64 hex) digest of the Runtime preparation disposition fact',
        };
      }
      continue;
    }
    if (key === 'replan_phase') {
      if (record[key] !== 'rotate' && record[key] !== 'recover' && record[key] !== 'rollback') {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: `request field "replan_phase" must be one of rotate|recover|rollback, received "${String(record[key])}"`,
        };
      }
      continue;
    }
    if (typeof record[key] !== 'string') {
      return {
        ok: false,
        code: 'RUNTIME.INPUT_INVALID',
        message: `request field "${key}" must be a string`,
      };
    }
  }
  const request: StageCliRequestInput = {
    domain: record.domain as string | undefined,
    operation: record.operation as string | undefined,
    stage: record.stage as string | undefined,
    manifest: record.manifest as string | undefined,
    previous_manifest_digest: record.previous_manifest_digest as string | undefined,
    evidence_dir: record.evidence_dir as string | undefined,
    mode: record.mode as string | undefined,
    disposition_ref: record.disposition_ref as string | undefined,
    disposition_digest: record.disposition_digest as string | undefined,
    replan_phase: record.replan_phase as string | undefined,
    input_path: record.input_path as string | undefined,
    output_path: record.output_path as string | undefined,
    role: record.role as string | undefined,
    slice: record.slice as string | undefined,
    task: record.task as string | undefined,
    observation: record.observation as string | undefined,
    observation_ref: record.observation_ref as string | undefined,
    ref: record.ref as string | undefined,
    envelope: record.envelope,
    verdict: record.verdict as string | undefined,
    snapshot_digest: record.snapshot_digest as string | undefined,
    summary: record.summary as string | undefined,
    commit_sha: record.commit_sha as string | undefined,
    cv_receipt_digest: record.cv_receipt_digest as string | undefined,
    close_type: record.close_type as string | undefined,
    reason: record.reason as string | undefined,
    manifest_digest: record.manifest_digest as string | undefined,
    manifest_path: record.manifest_path as string | undefined,
    e2e_receipt_path: record.e2e_receipt_path as string | undefined,
    reviewer_result_path: record.reviewer_result_path as string | undefined,
    output_dir: record.output_dir as string | undefined,
  };
  if (request.mode !== undefined && !['refresh', 'recover', 'rollback', 'replan'].includes(request.mode)) {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: `request field "mode" must be one of refresh|recover|rollback|replan, received "${request.mode}"`,
    };
  }
  // S15-A-T02: the replan fields are a closed tuple — `replan_phase` is only
  // legal with mode=replan, and mode=replan requires the Runtime preparation
  // disposition ref + digest (derived sets are never request fields, §8.8).
  if (request.replan_phase !== undefined && request.mode !== 'replan') {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: 'request field "replan_phase" is only legal with mode=replan',
    };
  }
  if (request.mode === 'replan') {
    if (request.disposition_ref !== undefined && request.disposition_ref.length > 0) {
      if (request.disposition_digest === undefined) {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: 'mode=replan requires the preparation disposition digest when disposition_ref is provided (request field "disposition_digest")',
        };
      }
    }
  }
  // S10-E-T02 repair: cutover 域 closed 字段（confirmed/delete_list）经超集
  // cast 附着到 request（与 S10-D project 域先例一致 —— 不动
  // CliRequestInput 接口，只由 cutover handler 消费）。
  const extended = request as unknown as Record<string, unknown>;
  if (record.confirmed !== undefined) extended['confirmed'] = record.confirmed;
  if (record.delete_list !== undefined) extended['delete_list'] = record.delete_list;
  // S10-SR-001 repair: the gate-domain `verification_source` is carried to
  // the gate handler through the same superset cast precedent (the closed
  // enum check above runs before this attachment).
  if (record.verification_source !== undefined) extended['verification_source'] = record.verification_source;
  // P-09: the gate-domain `re_gate` boolean is carried through the same
  // superset cast precedent (the boolean check above runs before this
  // attachment).
  if (record.re_gate !== undefined) extended['re_gate'] = record.re_gate;
  // A1 step 5: the plan-domain `check` boolean is carried through the same
  // superset cast precedent (the boolean check above runs before this
  // attachment; collectPlanParams reads it back into PlanOperationParams).
  if (record.check !== undefined) extended['check'] = record.check;
  return { ok: true, request };
}

/**
 * Resolve and validate the closed request input for a command:
 *  - `--request <root-relative-json>`: root-bound/no-follow read of the file
 *    (canonicalPathWithinRoot + readRootBoundFile, symlink escape fails
 *    closed); then JSON parse + closed schema.
 *  - `--json <closed-json>`: inline input with the same closed schema.
 *  - `--request` and `--json` are mutually exclusive input modes.
 *  - the request `domain`/`operation` (when present) must match the
 *    positionals exactly; a conflict fails closed before any handler runs.
 * Any illegal request yields a structured `RUNTIME.*` finding and must be
 * surfaced BEFORE any filesystem write (dispatcher maps it to exit 2).
 */
export function resolveRequestInput(
  root: string,
  command: CliCommand,
  parsed: ParsedCliArgs,
): CliRequestValidation {
  if (parsed.requestPath !== undefined && parsed.jsonInput !== undefined) {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: '--request and --json are mutually exclusive input modes',
    };
  }

  let raw: string | undefined;
  if (parsed.requestPath !== undefined) {
    // CV repair: the invocation contract requires a ROOT-RELATIVE request
    // path — an absolute path is refused even when it lies inside the root.
    if (path.isAbsolute(parsed.requestPath)) {
      return {
        ok: false,
        code: 'RUNTIME.INPUT_INVALID',
        message: `--request path must be root-relative (absolute path refused): "${parsed.requestPath}"`,
      };
    }
    if (canonicalPathWithinRoot(root, parsed.requestPath) === null) {
      return {
        ok: false,
        code: 'RUNTIME.PATH_OUTSIDE_ROOT',
        message: `--request path escapes the project root: "${parsed.requestPath}"`,
      };
    }
    try {
      raw = readRootBoundFile(root, parsed.requestPath).content;
    } catch (error) {
      return {
        ok: false,
        code: 'RUNTIME.INPUT_INVALID',
        message: `--request file is not readable: "${parsed.requestPath}" (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  } else if (parsed.jsonInput !== undefined) {
    raw = parsed.jsonInput;
  } else {
    return {
      ok: true,
      request: {
        domain: undefined,
        operation: undefined,
        stage: undefined,
        manifest: undefined,
        previous_manifest_digest: undefined,
        evidence_dir: undefined,
        mode: undefined,
        disposition_ref: undefined,
        disposition_digest: undefined,
        replan_phase: undefined,
        input_path: undefined,
        output_path: undefined,
        role: undefined,
        slice: undefined,
        task: undefined,
        observation: undefined,
        observation_ref: undefined,
        ref: undefined,
        envelope: undefined,
        verdict: undefined,
        snapshot_digest: undefined,
        summary: undefined,
        commit_sha: undefined,
        cv_receipt_digest: undefined,
        close_type: undefined,
        reason: undefined,
        manifest_digest: undefined,
        manifest_path: undefined,
        e2e_receipt_path: undefined,
        reviewer_result_path: undefined,
        output_dir: undefined,
      },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: 'request input is not valid JSON',
    };
  }
  const domain = command.domain as string;
  const parsedRequest = parseClosedRequestObject(value, domain);
  if (!parsedRequest.ok) return parsedRequest;

  if (parsedRequest.request.domain !== undefined && parsedRequest.request.domain !== command.domain) {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: `request domain "${parsedRequest.request.domain}" does not match command domain "${command.domain}"`,
    };
  }
  if (
    parsedRequest.request.operation !== undefined &&
    parsedRequest.request.operation !== command.operation
  ) {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: `request operation "${parsedRequest.request.operation}" does not match command operation "${command.operation}"`,
    };
  }
  // S10-B-T01: `--stage` flag and an inline/file request `stage` must agree
  // when both are present (same consistency rule as domain/operation).
  if (
    parsed.stage !== undefined &&
    parsedRequest.request.stage !== undefined &&
    parsed.stage !== parsedRequest.request.stage
  ) {
    return {
      ok: false,
      code: 'RUNTIME.INPUT_INVALID',
      message: `request stage "${parsedRequest.request.stage}" does not match --stage "${parsed.stage}"`,
    };
  }
  return parsedRequest;
}
