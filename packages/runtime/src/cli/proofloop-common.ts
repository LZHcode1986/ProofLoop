/**
 * proofloop-common.ts — shared helpers for the public proofloop CLI seam.
 *
 * Provides the closed domain/operation registry, the canonical JSON result
 * envelope, the exit contract and the canonical trust root assertion.  This
 * module never writes Receipts/Manifest/Context/Evidence and never imports a
 * harness SDK (OpenCode/Pi/Claude); it only consumes Node built-ins and the
 * runtime's own root-bound helpers.
 *
 * CLI cutover (bootstrap unlock): every legacy business-control domain
 * (authority/plan/context/stage/review/project/doctor/gate/recovery/cutover)
 * and its handlers/routes were removed — no fallback/compatibility alias
 * remains.  Only the mechanical public plumbing lives here (root/assertion,
 * canonical envelope, closed argv/request base parsing) and the mechanical
 * deterministic Git boundary adapter (`boundary`).  The registry is still the
 * single closed command matrix — unknown domain/operation must fail closed
 * before any write or input read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalPathWithinRoot } from '../path-guard';
import { readRootBoundFile } from '../vnext';
import { BOUNDARY_TYPES } from '../git-boundary';

// ============================================================
// Version / schema
// ============================================================

export const PROOFLOOP_CLI_SCHEMA_VERSION = 2;

/**
 * Runtime package version, read from `packages/runtime/package.json` so the
 * built dist CLI and the source tests report the same value.
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
// Exit contract
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
// Closed domain/operation registry (closed command matrix)
// ============================================================

export const CANONICAL_DOMAINS = [
  // CLI cutover: the only remaining domains are the mechanical deterministic
  // Git boundary adapter and the dedicated mechanical Integration adapter.
  'boundary',
  'integration',
] as const;

export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

export interface DomainRegistryEntry {
  readonly domain: CanonicalDomain;
  readonly operations: readonly string[];
}

export const DOMAIN_REGISTRY: Readonly<Record<CanonicalDomain, DomainRegistryEntry>> = {
  boundary: { domain: 'boundary', operations: ['close'] },
  integration: { domain: 'integration', operations: ['apply'] },
};

export function isCanonicalDomain(value: string): value is CanonicalDomain {
  return (CANONICAL_DOMAINS as readonly string[]).includes(value);
}

export function isCanonicalOperation(domain: CanonicalDomain, operation: string): boolean {
  return DOMAIN_REGISTRY[domain].operations.includes(operation);
}

// ============================================================
// Canonical CLI result envelope
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

export function errorEnvelope(command: CliCommand, code: string, message: string): CliEnvelope {
  return {
    ...baseEnvelope(command),
    ok: false,
    result: null,
    findings: [{ code, message }],
  };
}

/**
 * Canonical JSON serialization: recursively sorts object keys so that
 * logically equal envelopes produce byte-identical stdout regardless of
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

/** stdout must carry exactly one canonical JSON envelope line. */
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
 * Resolve a project root to its physical directory.  A root that is not an
 * existing directory is never accepted as a trust boundary.
 * (Inlined from the removed vnext-cli-support-vnext: mechanical root
 * assertion plumbing.)
 */
function resolveProjectRoot(projectRoot?: string): string {
  if (projectRoot !== undefined && (typeof projectRoot !== 'string' || projectRoot.length === 0)) {
    throw new Error('project-root must be a non-empty path');
  }
  const lexical = path.resolve(projectRoot ?? process.cwd());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lexical);
  } catch (error) {
    throw new Error(
      `project root is not readable: ${lexical} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`project root is not a directory: ${lexical}`);
  }
  const canonical = fs.realpathSync(lexical);
  return canonical;
}

/**
 * Resolve the canonical trust root:
 *  - explicit root (`--project-root` / `--root` flag or `PROOFLOOP_ROOT`
 *    env): must be an existing directory (realpath-canonicalized); when the
 *    cwd also auto-resolves to a different root, the explicit root fails
 *    closed (caller-provided project_root is a consistency assertion, never
 *    an override of the canonical root).
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
  /** `--project-root` (canonical) or `--root` alias. */
  readonly projectRoot: string | undefined;
  /** `--request <root-relative-json>` — root-bound/no-follow request file. */
  readonly requestPath: string | undefined;
  /**
   * `--json`: optional-value flag — `--json <closed-json>` is the inline
   * closed input; a bare `--json` (no value) is the JSON output mode
   * declaration and leaves `jsonInput` undefined.
   */
  readonly jsonInput: string | undefined;
  /**
   * `--stage <stage-id>`: target Stage ID for the boundary request
   * consistency check.  A canonical Stage ID (`^S\d+$`) is enforced by the
   * boundary handler; the flag itself is closed but generic so the
   * dispatcher can surface it to any domain.
   */
  readonly stage: string | undefined;
  /**
   * `--detail`: boolean flag of the read-only `proofloop status` entry —
   * requested the bounded L2 detail projection.  Closed but unused by the
   * mechanical boundary/integration domains.
   */
  readonly detail?: boolean;
  /**
   * `true` when a BARE `--json` (no value) declared structured JSON output
   * mode.  `--json <closed-json>` / `--json=<closed-json>` remain inline
   * request input mode and leave this false.
   */
  readonly jsonOutput?: boolean;
}

const VALUE_FLAGS = new Set(['--project-root', '--root', '--request', '--stage']);
const BOOLEAN_FLAGS = new Set(['--help', '--version', '--detail']);

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
  let detail = false;
  let jsonOutput = false;

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
        if (flag === '--detail') detail = true;
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
        continue;
      }
      if (flag === '--json') {
        // Optional-value flag: `--json <closed-json>` inline input, or
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
            jsonOutput = true;
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
    detail,
    jsonOutput,
  };
}

// ============================================================
// Closed request input (closed JSON object, unknown field fail
// closed; `--request` must be root-bound/no-follow)
// ============================================================

/**
 * Closed request schema fields.  After the CLI cutover both active domains
 * register fields: `boundary` registers the mechanical Git-boundary close
 * parameters and `integration` registers the dedicated mechanical
 * Integration apply parameters (candidate refs / base / declared changed
 * paths).  Unknown fields still fail closed.
 */
export interface CliRequestInput {
  readonly domain: string | undefined;
  readonly operation: string | undefined;
  /** Boundary close request fields (public deterministic Git adapter). */
  readonly boundary_type?: string | undefined;
  readonly expected_head?: string | undefined;
  readonly stage?: string | undefined;
  readonly slice?: string | undefined;
  /**
   * slice-output only: other-Slice declared dirty files. Tolerance scope
   * ONLY — never selected/staged/committed by this boundary.
   */
  readonly other_slice_declared_files?: readonly string[] | undefined;
  /**
   * Explicit exact dirty files tolerated by the boundary; never staged or
   * committed. This is separate from slice-output's other-Slice field.
   */
  readonly tolerated_paths?: readonly string[] | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly description?: string | undefined;
  readonly expected_branch?: string | undefined;
  /**
   * Integration apply fields (dedicated mechanical Integration transaction):
   * candidate_ref / candidate_base_ref are the Git refs of the CV `PASS`
   * candidate and its patch base (e.g. `proofloop-s01-a` and its base).
   */
  readonly candidate_ref?: string | undefined;
  readonly candidate_base_ref?: string | undefined;
  /** Integration Contract (D.1) closed fields. */
  readonly execution_mode?:
    | 'NORMAL'
    | 'PRE_MES_BOOTSTRAP'
    | 'MES_MAINTENANCE'
    | undefined;
  readonly expected_worktree?: string | undefined;
  readonly maintenance_binding?: Record<string, unknown> | undefined;
}

/**
 * NOTE (boundary closed schema): retired digest request fields are rejected;
 * `other_slice_declared_files` remains slice-output-only and `tolerated_paths`
 * is the explicit exact-file tolerance for ordinary boundaries.
 */

export type CliRequestValidation =
  | { readonly ok: true; readonly request: CliRequestInput }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Closed request field set per domain; other domains stay closed to {domain, operation}. */
const REQUEST_KNOWN_FIELDS_BY_DOMAIN: Readonly<Record<string, ReadonlySet<string>>> = {
  boundary: new Set([
    'domain',
    'operation',
    'boundary_type',
    'expected_head',
    'stage',
    'slice',
    'other_slice_declared_files',
    'tolerated_paths',
    'paths',
    'description',
    'expected_branch',
  ]),
  // Integration apply (dedicated mechanical Integration transaction):
  // candidate_ref / candidate_base_ref are Git refs of the CV `PASS`
  // candidate and its patch base; `paths` is the declared exact changed set.
  integration: new Set([
    'domain',
    'operation',
    'expected_head',
    'expected_branch',
    'stage',
    'slice',
    'candidate_ref',
    'candidate_base_ref',
    'paths',
    'execution_mode',
    'expected_worktree',
    'maintenance_binding',
  ]),
};

const REQUEST_BASE_FIELDS = new Set(['domain', 'operation']);

/** Closed Integration execution modes (integration.md D.1). */
export const INTEGRATION_EXECUTION_MODES = ['NORMAL', 'PRE_MES_BOOTSTRAP', 'MES_MAINTENANCE'] as const;

/** Lexical root-relative path check for integration worktree identities. */
function isCanonicalRootRelativeRequestPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '..');
}

/** Closed shape of the Integration MES_MAINTENANCE binding tuple. */
function validateMaintenanceBindingShape(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be a closed object';
  const known = new Set([
    'frozen_snapshot_ref', 'frozen_snapshot_sha256', 'frozen_fact_count',
    'forensic_ref', 'forensic_sha256', 'audit_ref', 'audit_sha256',
  ]);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!known.has(key)) return `unknown field "${key}"`;
  }
  for (const field of ['frozen_snapshot_ref', 'forensic_ref', 'audit_ref'] as const) {
    if (!isCanonicalRootRelativeRequestPath(record[field])) return `${field} must be a canonical root-relative ref`;
  }
  for (const field of ['frozen_snapshot_sha256', 'forensic_sha256', 'audit_sha256'] as const) {
    const digest = record[field];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return `${field} must be a 64-char lowercase hex sha256`;
  }
  const count = record.frozen_fact_count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return 'frozen_fact_count must be a positive integer';
  return undefined;
}

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
    if (key === 'paths' || key === 'other_slice_declared_files' || key === 'tolerated_paths') {
      if (!Array.isArray(record[key]) || record[key].some((entry) => typeof entry !== 'string' || entry.length === 0)) {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: `request field "${key}" must be an array of non-empty root-relative path strings`,
        };
      }
      continue;
    }
    if (key === 'boundary_type') {
      if (typeof record[key] !== 'string' || !(BOUNDARY_TYPES as readonly string[]).includes(record[key])) {
        return {
          ok: false,
          code: 'RUNTIME.INPUT_INVALID',
          message: `request field "boundary_type" must be one of ${BOUNDARY_TYPES.join('|')}`,
        };
      }
      continue;
    }
    // Integration Contract (D.1): execution_mode is a closed enum.
    if (key === 'execution_mode') {
      if (typeof record[key] !== 'string' || !(INTEGRATION_EXECUTION_MODES as readonly string[]).includes(record[key] as string)) {
        return { ok: false, code: 'RUNTIME.INPUT_INVALID', message: 'request field "execution_mode" must be one of NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE' };
      }
      continue;
    }
    if (key === 'expected_worktree') {
      if (!isCanonicalRootRelativeRequestPath(record[key])) {
        return { ok: false, code: 'RUNTIME.INPUT_INVALID', message: 'request field "expected_worktree" must be a canonical root-relative path' };
      }
      continue;
    }
    if (key === 'maintenance_binding') {
      const bindingError = validateMaintenanceBindingShape(record[key]);
      if (bindingError !== undefined) {
        return { ok: false, code: 'RUNTIME.INPUT_INVALID', message: `request field "maintenance_binding" is not a closed maintenance tuple: ${bindingError}` };
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
  // Integration Contract (D.1): mode-specific fields are required/forbidden as a closed set.
  if (domain === 'integration') {
    const mode = record.execution_mode as string | undefined;
    const hasBinding = record.maintenance_binding !== undefined;
    if (mode === undefined) return { ok: false, code: 'RUNTIME.INPUT_INVALID', message: 'integration request requires "execution_mode"' };
    if (record.expected_worktree === undefined) return { ok: false, code: 'RUNTIME.INPUT_INVALID', message: 'integration request requires "expected_worktree"' };
    if (mode === 'MES_MAINTENANCE' && !hasBinding) return { ok: false, code: 'RUNTIME.INPUT_INVALID', message: 'MES_MAINTENANCE integration request requires "maintenance_binding"' };
    if (mode !== 'MES_MAINTENANCE' && hasBinding) return { ok: false, code: 'RUNTIME.INPUT_INVALID', message: '"maintenance_binding" is only valid under execution_mode MES_MAINTENANCE' };
  }
  const request: CliRequestInput = {
    domain: record.domain as string | undefined,
    operation: record.operation as string | undefined,
    boundary_type: record.boundary_type as string | undefined,
    expected_head: record.expected_head as string | undefined,
    stage: record.stage as string | undefined,
    slice: record.slice as string | undefined,
    paths: Array.isArray(record.paths) ? record.paths as string[] : undefined,
    other_slice_declared_files: Array.isArray(record.other_slice_declared_files)
      ? record.other_slice_declared_files as string[]
      : undefined,
    tolerated_paths: Array.isArray(record.tolerated_paths)
      ? record.tolerated_paths as string[]
      : undefined,
    description: record.description as string | undefined,
    expected_branch: record.expected_branch as string | undefined,
    candidate_ref: record.candidate_ref as string | undefined,
    candidate_base_ref: record.candidate_base_ref as string | undefined,
    execution_mode: record.execution_mode as
      | 'NORMAL'
      | 'PRE_MES_BOOTSTRAP'
      | 'MES_MAINTENANCE'
      | undefined,
    expected_worktree: record.expected_worktree as string | undefined,
    maintenance_binding: record.maintenance_binding === undefined
      ? undefined
      : record.maintenance_binding as Record<string, unknown>,
  };
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
    // The invocation contract requires a ROOT-RELATIVE request path — an
    // absolute path is refused even when it lies inside the root.
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
  // `--stage` flag and an inline/file request `stage` must agree when both
  // are present (same consistency rule as domain/operation).
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