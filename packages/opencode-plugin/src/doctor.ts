/**
 * @proofloop/opencode-plugin — doctor checks engine (AWI-005).
 *
 * S01-C-T03: six canonical doctor checks (tech-spec/contract-state-matrix.md
 * §1.5) producing structured per-check results and an overall T01 ToolResult.
 *
 * Checks:
 *   1. versions       — lock runtime_version / plugin_package+plugin_version
 *                       vs ACTUAL package versions via the S01-B metadata seam
 *                       (`RUNTIME_LOCK_EXPECTATIONS`-shaped expectations and
 *                       `normalizeAuthorityRuntimeLock`); mismatch →
 *                       RUNTIME.VERSION_MISMATCH.
 *   2. git            — branch/HEAD/dirty through the runtime process seam
 *                       (`runProcess` executing structured git read-only
 *                       commands; no shell concatenation, no CLI subprocess);
 *                       non-git / unborn HEAD → RUNTIME.SCHEMA_MISMATCH
 *                       (runtime GitSourceError precedent), dirty worktree →
 *                       warn RUNTIME.SCHEMA_MISMATCH.
 *   3. commands       — structured CommandSpec probes (e.g. node --version)
 *                       through `runProcess` with bounded output/timeout and
 *                       AbortSignal passthrough; a failed/canceled/timed-out
 *                       probe → RUNTIME.SCHEMA_MISMATCH.
 *   4. artifacts      — `.proofloop` existence and readability under the
 *                       canonical projectRoot; missing → HOST.PROJECT_NOT_TRUSTED.
 *   5. receipt-schema — kernel Receipt schema baseline (version = 1) vs the
 *                       observed schema version → RUNTIME.SCHEMA_MISMATCH.
 *   6. host-api       — OC-0 host capability matrix (host-compatibility.md);
 *                       any missing required capability → RUNTIME.SCHEMA_MISMATCH.
 *
 * The engine accepts injected runtime seams (runProcess, version expectations,
 * host facts) so failure fixtures are deterministic. It never swallows errors
 * into empty findings and never fakes a PASS: any unexpected exception is
 * mapped through T01's fail-closed `toErrorResult` boundary. All Finding codes
 * come from the kernel closed set — no new Finding code or flow semantics.
 */

import { accessSync, readFileSync, statSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ProcessResult, SpawnOptions } from '@proofloop/runtime';
import type { ValidatedFinding } from '@proofloop/runtime';
import type { LoggerAdapter } from './adapters/logger.js';
import type { ReceiptRef, RuntimeMetadata, ToolResult } from './tool-result.js';
import { toErrorResult } from './tool-result.js';
import type { RuntimeLockMetadata } from './runtime-lock.js';
import { normalizeAuthorityRuntimeLock, validateRuntimeLockAt } from './runtime-lock.js';
import {
  PROOFLOOP_DIR,
  RUNTIME_LOCK_FILE,
  detectProject,
  type ProjectDetectionDecision,
} from './project-detection.js';
import { diagnosticLogRef } from './compact.js';

/** Canonical doctor check identifiers (contract-state-matrix §1.5). */
export type DoctorCheckId =
  | 'versions'
  | 'git'
  | 'commands'
  | 'artifacts'
  | 'receipt-schema'
  | 'host-api';

/** Per-check status. */
export type DoctorCheckStatus = 'pass' | 'fail';

/** Structured result of one canonical doctor check. */
export interface DoctorCheck {
  checkId: DoctorCheckId;
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  finding?: ValidatedFinding;
  /** Traceable reference for the check (lock path, HEAD, command, …). */
  ref?: string;
}

/** Structured command probe executed through the runtime process seam. */
export interface CommandProbe {
  id: string;
  name: string;
  executable: string;
  args: string[];
}

/**
 * OC-0 host capability facts injected by the host adapter. Each boolean
 * records whether the host exposes the capability (host-compatibility.md
 * Compatibility Matrix).
 */
export interface HostFacts {
  /** Custom tool registration `tool({ description, args, execute })`. */
  toolRegistration: boolean;
  /** ToolContext.agent identity at execute time. */
  agentIdentity: boolean;
  /** ToolContext.abort (AbortSignal) cancellation. */
  cancellation: boolean;
  /** client.app.log logging endpoint. */
  logging: boolean;
  /** PluginInput/ToolContext provide directory + worktree. */
  worktreeDirectory: boolean;
}

/** Runtime process-runner seam (injected for deterministic test fixtures). */
export type RunProcessSeam = (options: SpawnOptions) => Promise<ProcessResult>;

/** Dependencies injected into the doctor checks engine. */
export interface DoctorDeps {
  /** Canonical worktree trust root (RuntimeContext.projectRoot). */
  projectRoot: string;
  /** Runtime process-runner seam (bounded output/timeout/AbortSignal). */
  runProcess: RunProcessSeam;
  /** Actual package/version expectations (S01-B metadata seam shape). */
  expectations: RuntimeLockMetadata;
  /** OC-0 host capability facts. */
  hostFacts: HostFacts;
  /** Logger adapter for full diagnostics. */
  logger: LoggerAdapter;
  /** Cancellation signal passed through to every runProcess call. */
  cancellationSignal?: AbortSignal;
  /** Lock path override (defaults to projectRoot/.proofloop/runtime.lock). */
  lockPath?: string;
  /** Command probes to run (defaults to `node --version`). */
  commandProbes?: readonly CommandProbe[];
  /** Observed Receipt schema version (defaults to the kernel baseline 1). */
  observedSchemaVersion?: number;
  /**
   * Caller role (ToolContext.agent at tool-execute time). S1 semantics: the
   * doctor is available to ALL roles (FR-006); the caller role is carried
   * explicitly for diagnostics and as the S4 extension point for the full
   * role×tool isolation matrix.
   */
  callerRole?: string;
}

/** Result of a doctor run: per-check list + the overall T01 ToolResult. */
export interface DoctorResult {
  checks: readonly DoctorCheck[];
  result: ToolResult;
}

/** Kernel Receipt schema version baseline (Receipt.version must be 1). */
export const RECEIPT_SCHEMA_VERSION = 1;

/** Default local command probe (structured CommandSpec, via runProcess). */
export const DEFAULT_COMMAND_PROBES: readonly CommandProbe[] = [
  { id: 'node', name: 'Node.js runtime', executable: 'node', args: ['--version'] },
];

function errorFinding(code: ValidatedFinding['code'], message: string): ValidatedFinding {
  return { code, severity: 'error', message };
}

function warnFinding(code: ValidatedFinding['code'], message: string): ValidatedFinding {
  return { code, severity: 'warn', message };
}

function passCheck(
  checkId: DoctorCheckId,
  name: string,
  detail: string,
  ref?: string,
): DoctorCheck {
  return { checkId, name, status: 'pass', detail, ref };
}

function failCheck(
  checkId: DoctorCheckId,
  name: string,
  detail: string,
  finding: ValidatedFinding,
  ref?: string,
): DoctorCheck {
  return { checkId, name, status: 'fail', detail, finding, ref };
}

/** True when a process completed successfully (exit 0, not canceled/timed out). */
function isProcessOk(result: ProcessResult): boolean {
  return result.exitCode === 0 && !result.canceled && !result.timedOut;
}

/** Runtime metadata projection filled from the version expectations. */
function runtimeMetadata(e: RuntimeLockMetadata): RuntimeMetadata {
  return {
    runtimeVersion: e.runtimeVersion.ok ? e.runtimeVersion.version : '',
    pluginVersion: e.pluginVersion.ok ? e.pluginVersion.version : '',
    schemaVersion: e.schemaVersion,
  };
}

// ---------------------------------------------------------------------------
// Check 1 — runtime/plugin versions (S01-B lock gate propagated)
// ---------------------------------------------------------------------------

/**
 * S01-B detection decision for this doctor run (S1-F-001): lock presence +
 * fail-closed `validateRuntimeLockAt` verdict. The decision is carried into
 * the doctor so an incompatible lock can never be hidden by other healthy
 * checks. The optional `lockPath` override binds the validator to the override
 * path while detection still anchors at the canonical trust root.
 */
function lockDecision(deps: DoctorDeps): ProjectDetectionDecision {
  return detectProject(deps.projectRoot, (lockPath) =>
    validateRuntimeLockAt(deps.lockPath ?? lockPath, deps.expectations),
  );
}

function checkVersions(
  deps: DoctorDeps,
  decision: ProjectDetectionDecision,
): DoctorCheck {
  const name = 'runtime/plugin 版本';
  const lockPath =
    deps.lockPath ?? path.join(deps.projectRoot, PROOFLOOP_DIR, RUNTIME_LOCK_FILE);

  // S1-F-001: distinguish "non-ProofLoop, no lock" (expected diagnostic — the
  // version check is not applicable and the doctor remains usable) from
  // "lock present but incompatible/inactive" (fail-closed with the S01-B
  // seam's canonical Finding: HOST.PROJECT_NOT_TRUSTED /
  // RUNTIME.SCHEMA_MISMATCH / RUNTIME.VERSION_MISMATCH).
  if (!decision.lockPresent) {
    return passCheck(
      'versions',
      name,
      `No ${RUNTIME_LOCK_FILE} at ${lockPath}; not a ProofLoop project — version compatibility is not applicable`,
      lockPath,
    );
  }
  if (!decision.active) {
    const message = decision.findings.map((f) => f.message).join('; ');
    const first =
      decision.findings[0] ??
      errorFinding(
        'RUNTIME.SCHEMA_MISMATCH',
        `${RUNTIME_LOCK_FILE} at ${lockPath} is not compatible with this plugin.`,
      );
    return failCheck('versions', name, message, first, lockPath);
  }

  // Active lock: report the validated versions (re-read for the pass detail).
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    const normalizedResult = normalizeAuthorityRuntimeLock(parsed);
    if (normalizedResult.ok) {
      const normalized = normalizedResult.normalized;
      return passCheck(
        'versions',
        name,
        `runtime ${normalized.runtime_version} and plugin ${normalized.extension_package}@${normalized.extension_version} match expected versions`,
        lockPath,
      );
    }
  } catch {
    // Unreachable for an active decision (the seam already validated the
    // lock); keep a truthful fallback rather than fabricating version numbers.
  }
  return passCheck(
    'versions',
    name,
    `runtime.lock validates at ${lockPath}; version compatibility confirmed`,
    lockPath,
  );
}

// ---------------------------------------------------------------------------
// Check 2 — Git (branch/HEAD/dirty) through the runtime process seam
// ---------------------------------------------------------------------------

async function checkGit(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'Git';
  const cwd = deps.projectRoot;

  const branch = await deps.runProcess({
    executable: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd,
    cancellationSignal: deps.cancellationSignal,
  });
  if (!isProcessOk(branch)) {
    return failCheck(
      'git',
      name,
      `git is unavailable or ${cwd} is not a git work tree`,
      errorFinding(
        'RUNTIME.SCHEMA_MISMATCH',
        `git branch detection failed at ${cwd}: ${branch.stderr.trim() || 'git unavailable'}. Not a git work tree or HEAD unborn.`,
      ),
      cwd,
    );
  }

  const head = await deps.runProcess({
    executable: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd,
    cancellationSignal: deps.cancellationSignal,
  });
  if (!isProcessOk(head)) {
    return failCheck(
      'git',
      name,
      `git HEAD resolution failed at ${cwd}`,
      errorFinding(
        'RUNTIME.SCHEMA_MISMATCH',
        `git HEAD resolution failed at ${cwd}: ${head.stderr.trim()}`,
      ),
      cwd,
    );
  }

  const status = await deps.runProcess({
    executable: 'git',
    // S1-F-002: `--untracked-files=no` keeps the doctor from failing its own
    // git check when it writes its diagnostic log to `.proofloop/logs/`
    // (untracked). "Dirty" means modified/staged TRACKED files — untracked
    // files are not VCS-dirty state and are typically gitignored.
    args: ['status', '--porcelain', '--untracked-files=no'],
    cwd,
    cancellationSignal: deps.cancellationSignal,
  });
  if (!isProcessOk(status)) {
    return failCheck(
      'git',
      name,
      `git status --porcelain failed at ${cwd}`,
      errorFinding(
        'RUNTIME.SCHEMA_MISMATCH',
        `git status --porcelain failed at ${cwd}: ${status.stderr.trim()}`,
      ),
      cwd,
    );
  }

  const branchName = branch.stdout.trim();
  const headSha = head.stdout.trim();
  const ref = headSha.length > 0 ? headSha : cwd;
  const dirty = status.stdout.trim().length > 0;

  if (dirty) {
    return failCheck(
      'git',
      name,
      `git worktree at ${cwd} is dirty (${headSha})`,
      warnFinding(
        'RUNTIME.SCHEMA_MISMATCH',
        `git worktree is dirty at ${cwd}: git status --porcelain is non-empty. Commit or stash before proceeding.`,
      ),
      ref,
    );
  }
  return passCheck('git', name, `git ${branchName} @ ${headSha}, clean worktree`, ref);
}

// ---------------------------------------------------------------------------
// Check 3 — Project commands & services (structured CommandSpec probes)
// ---------------------------------------------------------------------------

async function checkCommands(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = '项目命令与服务';
  const probes = deps.commandProbes ?? DEFAULT_COMMAND_PROBES;
  if (probes.length === 0) {
    return passCheck('commands', name, 'no command probes configured');
  }

  for (const probe of probes) {
    const result = await deps.runProcess({
      executable: probe.executable,
      args: probe.args,
      cwd: deps.projectRoot,
      cancellationSignal: deps.cancellationSignal,
    });
    if (!isProcessOk(result)) {
      const ref = `${probe.executable} ${probe.args.join(' ')}`;
      const reason = result.canceled
        ? 'canceled by AbortSignal'
        : result.timedOut
          ? `timed out`
          : result.stderr.trim() || `exit ${result.exitCode}`;
      return failCheck(
        'commands',
        name,
        `command probe "${probe.name}" (${ref}) failed: ${reason}`,
        errorFinding(
          'RUNTIME.SCHEMA_MISMATCH',
          `Command probe "${probe.name}" (${ref}) failed at ${deps.projectRoot}: ${reason}.`,
        ),
        ref,
      );
    }
  }
  return passCheck('commands', name, `all ${probes.length} command probe(s) succeeded`);
}

// ---------------------------------------------------------------------------
// Check 4 — Artifact root (.proofloop existence and permissions)
// ---------------------------------------------------------------------------

function checkArtifacts(
  deps: DoctorDeps,
  decision: ProjectDetectionDecision,
): DoctorCheck {
  const name = 'artifact 根';
  const proofloopDir = path.join(deps.projectRoot, PROOFLOOP_DIR);

  try {
    const st = statSync(proofloopDir);
    if (!st.isDirectory()) {
      return failCheck(
        'artifacts',
        name,
        `${proofloopDir} exists but is not a directory`,
        errorFinding(
          'HOST.PROJECT_NOT_TRUSTED',
          `${proofloopDir} exists but is not a directory under trust root ${deps.projectRoot}.`,
        ),
        proofloopDir,
      );
    }
    accessSync(proofloopDir, fsConstants.R_OK);
    return passCheck('artifacts', name, `${proofloopDir} exists and is readable`, proofloopDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // S1-F-001: a missing `.proofloop` in a non-ProofLoop project is an
      // expected diagnostic (annotated in the detail), NOT a fail-closed
      // failure — the doctor remains usable in ordinary projects.
      if (!decision.lockPresent) {
        return passCheck(
          'artifacts',
          name,
          `No ${PROOFLOOP_DIR} under trust root ${deps.projectRoot}; not a ProofLoop project — artifact root check not applicable`,
          proofloopDir,
        );
      }
      return failCheck(
        'artifacts',
        name,
        `${proofloopDir} is missing under trust root ${deps.projectRoot}`,
        errorFinding(
          'HOST.PROJECT_NOT_TRUSTED',
          `No ${PROOFLOOP_DIR} directory under trust root ${deps.projectRoot}; not a ProofLoop project.`,
        ),
        proofloopDir,
      );
    }
    return failCheck(
      'artifacts',
      name,
      `${proofloopDir} is not accessible`,
      errorFinding(
        'RUNTIME.SCHEMA_MISMATCH',
        `${proofloopDir} is not accessible at ${deps.projectRoot}: ${String(error)}`,
      ),
      proofloopDir,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 5 — Receipt schema version (kernel baseline vs observed)
// ---------------------------------------------------------------------------

function checkReceiptSchema(deps: DoctorDeps): DoctorCheck {
  const name = 'Receipt schema 版本';
  const observed = deps.observedSchemaVersion ?? RECEIPT_SCHEMA_VERSION;
  if (observed !== RECEIPT_SCHEMA_VERSION) {
    return failCheck(
      'receipt-schema',
      name,
      `receipt schema version ${observed} does not match kernel baseline ${RECEIPT_SCHEMA_VERSION}`,
      errorFinding(
        'RUNTIME.SCHEMA_MISMATCH',
        `Receipt schema version ${observed} does not match the kernel baseline ${RECEIPT_SCHEMA_VERSION}.`,
      ),
      `receipt-schema:v${observed}`,
    );
  }
  return passCheck(
    'receipt-schema',
    name,
    `kernel Receipt schema version ${RECEIPT_SCHEMA_VERSION}`,
    `receipt-schema:v${observed}`,
  );
}

// ---------------------------------------------------------------------------
// Check 6 — Host API compatibility (OC-0 matrix)
// ---------------------------------------------------------------------------

function checkHostApi(deps: DoctorDeps): DoctorCheck {
  const name = 'Host API compatibility';
  const required: ReadonlyArray<[keyof HostFacts, string]> = [
    ['toolRegistration', 'custom tool registration tool({ description, args, execute })'],
    ['agentIdentity', 'ToolContext.agent identity'],
    ['cancellation', 'ToolContext.abort cancellation signal'],
    ['logging', 'client.app.log logging endpoint'],
    ['worktreeDirectory', 'PluginInput/ToolContext directory + worktree'],
  ];
  const missing = required.filter(([key]) => !deps.hostFacts[key]);
  if (missing.length > 0) {
    const labels = missing.map(([, label]) => label).join('; ');
    const refs = missing.map(([key]) => `host:${key}`).join(',');
    return failCheck(
      'host-api',
      name,
      `host API is missing required capabilities: ${labels}`,
      errorFinding('RUNTIME.SCHEMA_MISMATCH', `Host API is missing required capabilities: ${labels}.`),
      refs,
    );
  }
  return passCheck('host-api', name, 'host API provides all OC-0 required capabilities');
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run all six canonical doctor checks and assemble the overall T01 ToolResult.
 *
 * Every check runs (diagnostic tool — no short-circuit) and is guarded
 * individually: a single check throwing (e.g. the runtime process seam
 * rejecting a probe) becomes THAT check's own structured failure (canonical
 * Finding + ref) — the six-check record stays complete and the status stays
 * honest (never a fake "all 0 checks passed"). The overall result is
 * `ok:false` whenever ANY check reports a Finding (no fake PASS, no empty
 * findings). Unexpected exceptions outside the guarded checks are mapped
 * through T01's fail-closed `toErrorResult` boundary — a bare exception never
 * leaks.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult> {
  try {
    return await runDoctorInternal(deps);
  } catch (error) {
    const failClosed = toErrorResult(error, {
      runtime: runtimeMetadata(deps.expectations),
    });
    return { checks: [], result: failClosed };
  }
}

async function runDoctorInternal(deps: DoctorDeps): Promise<DoctorResult> {
  // S01-B detection + lock gate (fail-closed seam) carried into the doctor
  // (S1-F-001): an incompatible lock can never be hidden by other healthy
  // checks.
  const decision = lockDecision(deps);

  const checks: DoctorCheck[] = [];
  checks.push(await guardedCheck(() => checkVersions(deps, decision), 'versions', 'runtime/plugin 版本', deps));
  checks.push(await guardedCheck(() => checkGit(deps), 'git', 'Git', deps));
  checks.push(await guardedCheck(() => checkCommands(deps), 'commands', '项目命令与服务', deps));
  checks.push(await guardedCheck(() => checkArtifacts(deps, decision), 'artifacts', 'artifact 根', deps));
  checks.push(await guardedCheck(() => checkReceiptSchema(deps), 'receipt-schema', 'Receipt schema 版本', deps));
  checks.push(await guardedCheck(() => checkHostApi(deps), 'host-api', 'Host API compatibility', deps));

  const checkFindings = checks.flatMap((c) => (c.finding ? [c.finding] : []));
  // When the lock exists but is inactive, EVERY canonical Finding from the
  // S01-B seam must surface — the versions check carries the first one on its
  // own record; the rest are appended here so none is swallowed by the
  // aggregation (S1-F-001).
  const versions = checks.find((c) => c.checkId === 'versions');
  const extraLockFindings =
    decision.lockPresent && !decision.active && versions?.status === 'fail'
      ? decision.findings.slice(1)
      : [];
  const findings: ValidatedFinding[] = [
    ...checkFindings,
    ...extraLockFindings,
  ];

  // Full diagnostics always go to the logger FIRST so a file-persistence
  // failure (S1-F-002) is observed before the result is assembled.
  deps.logger.info('doctor: full diagnostics', {
    projectRoot: deps.projectRoot,
    callerRole: deps.callerRole,
    ok: findings.length === 0,
    checks,
    findings,
  });

  // S1-F-002 fail-closed: the logger is configured for `.proofloop/logs/`
  // persistence but the file sink is unhealthy (directory missing/unwritable)
  // → a structured Finding, never a silent "persisted" claim.
  if (deps.logger.persisted && !deps.logger.fileHealthy) {
    findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'error',
      message: `Diagnostic log persistence failed: cannot write ${PROOFLOOP_DIR}/logs/ under ${deps.projectRoot}; full diagnostics were not persisted to disk.`,
    });
  }

  const ok = findings.length === 0;

  const result: ToolResult = {
    ok,
    data: {
      checks,
      logRef: diagnosticLogRef(deps.logger),
      projectDetected: decision.projectDetected,
      ...(deps.callerRole !== undefined ? { callerRole: deps.callerRole } : {}),
    },
    findings,
    refs: [] as readonly ReceiptRef[],
    runtime: runtimeMetadata(deps.expectations),
  };

  return { checks, result };
}

/**
 * Run one check and convert ANY unexpected exception into that check's own
 * structured failure (canonical Finding + ref). A single check's throw must
 * never blank the whole check list or fake an all-pass status.
 */
async function guardedCheck(
  run: () => DoctorCheck | Promise<DoctorCheck>,
  checkId: DoctorCheckId,
  name: string,
  deps: DoctorDeps,
): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (error) {
    const message = `Check "${checkId}" failed unexpectedly: ${String(error)}`;
    return failCheck(
      checkId,
      name,
      message,
      errorFinding('RUNTIME.SCHEMA_MISMATCH', message),
      deps.projectRoot,
    );
  }
}
