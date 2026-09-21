#!/usr/bin/env node
/**
 * proofloop.ts — public proofloop CLI dispatcher (seam base).
 *
 *   proofloop <domain> <operation> [--request <root-relative-json>]
 *            [--json <closed-json>] [--project-root <path>]
 *
 * Contract:
 *  - stdout carries exactly ONE canonical JSON envelope; no natural-language
 *    prefix on success or refusal;
 *  - exit: 0 = completed/read-ready, 1 = usage/schema/runtime failure,
 *    2 = structured blocked/refused/no-write;
 *  - domain/operation come from the closed registry; unknown domain or
 *    operation fails closed (RUNTIME.SCHEMA_MISMATCH, exit 2) BEFORE any
 *    filesystem write and BEFORE any request input read;
 *  - the canonical trust root is asserted before any artifact path is used;
 *    `--project-root` is a consistency assertion, never an override;
 *  - the CLI never imports a harness SDK and never writes Receipts/Manifest/
 *    Context/Evidence directly.
 *
 * CLI cutover (bootstrap unlock): every legacy business-control domain
 * (authority/plan/context/stage/review/project/doctor/gate/recovery/cutover)
 * and its handlers/routes were removed — no fallback/compatibility alias
 * remains.  The two active mechanical routes are the deterministic Git
 * boundary adapter (`boundary close`) and the dedicated mechanical
 * Integration adapter (`integration apply`).
 */

import { runBoundaryDomain } from './proofloop-boundary';
import { runIntegrationDomain } from './proofloop-integration';
import { readMesSeedRecord, isMesSeeded, readMesSnapshotFacts } from '../mes/bootstrap';
import type { MesStatusTuple } from '../mes/bootstrap';
import {
  projectSparseStatus,
  projectDetailStatus,
  formatSparseStatus,
  formatDetailStatus,
  projectCycleFilteredStatus,
  projectCycleFilteredDetail,
  projectTerminalAdjunct,
  formatProjectTerminalAdjunct,
  MesStatusError,
} from '../mes/status';
import {
  CANONICAL_DOMAINS,
  CLI_EXIT,
  DOMAIN_REGISTRY,
  PROOFLOOP_ROOT_ENV,
  PROOFLOOP_RUNTIME_VERSION,
  emitEnvelope,
  errorEnvelope,
  isCanonicalDomain,
  isCanonicalOperation,
  okEnvelope,
  parseCliArgs,
  resolveRequestInput,
  resolveTrustRoot,
  TrustRootError,
  type CliCommand,
  type CliEnvelope,
  type ParsedCliArgs,
} from './proofloop-common';

export interface ProofloopCliOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Options of the read-only `proofloop status` observation entry.
 */
export interface StatusCliOptions {
  /** Bounded L2 detail projection requests (`proofloop status --detail`). */
  readonly detail: boolean;
  /** Structured JSON projection (`proofloop status --json`); false = human-readable. */
  readonly jsonOutput: boolean;
}

/** Structured blocked error carrying its canonical finding code. */
export class CliBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CliBlockedError';
    this.code = code;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blockedCodeOf(error: unknown): string {
  if (error instanceof TrustRootError) return error.code;
  if (error instanceof CliBlockedError) return error.code;
  return 'RUNTIME.BLOCKED';
}

/**
 * Read-only `proofloop status` observation entry (S01-C-T02).
 *
 * Projects the durable bootstrap seed facts through the pure status/detail
 * projections (mes.md status L1/L2, contracts.md §2.3 / §2.4):
 *   - `status` / `status --detail`      — deterministic human-readable view;
 *   - `status --json` / `status --json --detail` — same facts, structured.
 *
 * It NEVER writes facts, is NOT part of DOMAIN_REGISTRY / CANONICAL_DOMAINS
 * (no business-control/legacy domain is added — ADR-009/010, STATIC-05/14)
 * and fails closed (exit 2, structured finding) on a missing, corrupt,
 * not-fully-seeded or unknown root-bound store input without mutating
 * anything. Output never contains next_action / route / reasoning.
 */
export function runStatusDomain(root: string, options: StatusCliOptions): CliEnvelope {
  const command: CliCommand = { domain: 'status', operation: null };
  let record: ReturnType<typeof readMesSeedRecord>;
  try {
    record = readMesSeedRecord(root);
  } catch (error) {
    return errorEnvelope(command, 'RUNTIME.BLOCKED', `cannot read MES status: ${errorMessage(error)}`);
  }
  // (EC-1 / CV S05-C-cv-1) isMesSeeded re-reads the snapshot store and can
  // fail closed on a corrupt/unreadable snapshot (MesSnapshotStoreError) —
  // the public entry must catch it and return ONE structured
  // RUNTIME.BLOCKED envelope, never throw.
  let seeded = false;
  if (record !== null) {
    try {
      seeded = isMesSeeded(root);
    } catch (error) {
      return errorEnvelope(command, 'RUNTIME.BLOCKED', `cannot read MES status: ${errorMessage(error)}`);
    }
  }
  if (!seeded) {
    // (S05-C-T02 / PO-S05-C-03) Post-recovery reachability: when the one-time
    // seed record / seed-owned facts are unavailable after a LEGAL recovery
    // baseline, the public status entry derives the cycle-filtered current
    // status from the DURABLE facts alone — it never backfills missing
    // seed-owned facts and never revives PRE_MES_BOOTSTRAP. Without a
    // recovery context the existing fail-closed refusal is preserved.
    return statusFromDurableFacts(
      root,
      command,
      options,
      record === null
        ? 'MES status requires a seeded store (seedMesBootstrap first) or a legal recovery baseline'
        : 'MES store is not fully seeded (seed record / snapshot facts mismatch)',
    );
  }
  // (PO-S05-C-03) A SEEDED store may ALSO carry a newer legal NORMAL cycle
  // in its durable facts (a unique same-cycle in-flight candidate/accepted
  // planning binding — e.g. after a legal recovery baseline, the fresh
  // NORMAL cycle's PVR/PA). The public status must then project the CURRENT
  // durable cycle-filtered status instead of the stale seed tuple; the
  // seeded legacy projection below stays only when the durable facts carry
  // no newer current cycle. Typed AUTHORITY_GAP / RUNTIME.BLOCKED envelopes
  // are preserved and nothing is written or backfilled.
  const currentCycleEnvelope = seededStatusFromDurableFacts(root, command, options);
  if (currentCycleEnvelope !== null) {
    return currentCycleEnvelope;
  }
  // After the early returns above, `record` is a non-null seed record and
  // the durable facts carry no newer current NORMAL cycle — seeded legacy
  // projection of the seed tuple.
  const seedRecord: NonNullable<typeof record> = record as NonNullable<typeof record>;
  try {
    // (repair CV S06-B-restart-cv-1 / contracts 2.3.1) The seeded legacy
    // projection stays primary, but when the DURABLE facts also carry a legal
    // terminal observation (a retained no-cycle legacy PROJECT_READY →
    // HISTORICAL_PROJECT_READY; a legal chain tip → CURRENT_PROJECT_READY; a
    // unique open cycle → PRE_TERMINAL), the public status exposes the
    // projection-only `project_terminal` adjunct in every form — never
    // invented, no write/backfill, same S06-A seam. Broken / ambiguous
    // terminal relations fail closed typed (STATIC-30/31).
    const durableFacts = readMesSnapshotFacts(root);
    const adjunct = projectTerminalAdjunct(durableFacts);
    const sparseBase = projectSparseStatus(seedRecord.status);
    const detailBase = projectDetailStatus(seedRecord);
    const result = options.detail
      ? options.jsonOutput
        ? adjunct !== undefined
          ? { ...detailBase, project_terminal: adjunct }
          : detailBase
        : formatDetailStatus(
            adjunct !== undefined ? { ...detailBase, project_terminal: adjunct } : detailBase,
          )
      : options.jsonOutput
        ? adjunct !== undefined
          ? { ...sparseBase, project_terminal: adjunct }
          : sparseBase
        : formatSparseStatus(sparseBase) +
          (adjunct !== undefined ? `\n${formatProjectTerminalAdjunct(adjunct)}` : '');
    return okEnvelope(command, result);
  } catch (error) {
    if (error instanceof MesStatusError && error.code === 'authority-gap') {
      return errorEnvelope(command, 'AUTHORITY_GAP', `cannot project seeded MES status: ${errorMessage(error)}`);
    }
    return errorEnvelope(command, 'RUNTIME.BLOCKED', `cannot project MES status: ${errorMessage(error)}`);
  }
}

/**
 * (S05-C-T02 / PO-S05-C-03) Post-recovery cycle-filtered status observation
 * path: reads the durable snapshot facts and — only when the store carries a
 * legal recovery baseline — projects the current NORMAL cycle status
 * (cycle-filtered, evaluated from the durable facts' unique same-cycle
 * in-flight binding). The read NEVER writes: no missing seed-owned facts are
 * backfilled and PRE_MES_BOOTSTRAP stays permanently closed. When the
 * current-cycle observation path cannot be proven from the Authority, the
 * entry stops with a typed AUTHORITY_GAP refusal instead of inventing
 * semantics.
 */
function statusFromDurableFacts(
  root: string,
  command: CliCommand,
  options: StatusCliOptions,
  missingMessage: string,
): CliEnvelope {
  let facts: ReturnType<typeof readMesSnapshotFacts>;
  try {
    facts = readMesSnapshotFacts(root);
  } catch (error) {
    return errorEnvelope(command, 'RUNTIME.BLOCKED', `cannot read MES snapshot facts: ${errorMessage(error)}`);
  }
  if (!facts.some((fact) => fact.fact_kind === 'recovery_baseline')) {
    return errorEnvelope(command, 'RUNTIME.BLOCKED', missingMessage);
  }
  return projectCurrentCycleEnvelope(command, options, facts);
}

/**
 * (PO-S05-C-03) Seeded-store current-cycle observation: when a seeded store
 * ALSO contains a newer legal NORMAL cycle — its durable facts carry at least
 * one cycle-bearing in-flight candidate/accepted planning binding (PVR/PA
 * with a non-empty `plan_binding.delivery_cycle_id`) — the public status
 * projects the CURRENT durable cycle-filtered status instead of the stale
 * seed tuple.
 *
 * Returns `null` when the durable facts carry NO current-cycle planning
 * binding (a purely legacy seeded store — the caller keeps the seeded legacy
 * projection of the seed tuple). A present but ambiguous / unprovable current
 * cycle fails closed with the typed envelope — the stale seed tuple is never
 * returned and nothing is written or backfilled.
 */
function seededStatusFromDurableFacts(
  root: string,
  command: CliCommand,
  options: StatusCliOptions,
): CliEnvelope | null {
  let facts: ReturnType<typeof readMesSnapshotFacts>;
  try {
    facts = readMesSnapshotFacts(root);
  } catch (error) {
    return errorEnvelope(command, 'RUNTIME.BLOCKED', `cannot read MES snapshot facts: ${errorMessage(error)}`);
  }
  const hasCurrentCycleBinding = facts.some(
    (fact) =>
      (fact.fact_kind === 'planning_verification_result' || fact.fact_kind === 'plan_acceptance') &&
      fact.plan_binding !== undefined &&
      fact.plan_binding.delivery_cycle_id !== undefined &&
      fact.plan_binding.delivery_cycle_id.length > 0,
  );
  if (!hasCurrentCycleBinding) {
    return null;
  }
  return projectCurrentCycleEnvelope(command, options, facts);
}

/**
 * Shared current-cycle projection envelope: cycle-filtered status (and, for
 * `--detail`, the bounded binding detail) projected from the durable facts.
 * Failures map to the typed envelopes: `AUTHORITY_GAP` when the current-cycle
 * observation path cannot be proven from the Authority, `RUNTIME.BLOCKED`
 * otherwise. Read-only: never writes, never backfills, emits no route / next
 * action / reasoning (HP-001 / HP-007 / STATIC-05).
 */
function projectCurrentCycleEnvelope(
  command: CliCommand,
  options: StatusCliOptions,
  facts: ReturnType<typeof readMesSnapshotFacts>,
): CliEnvelope {
  try {
    const current = projectCycleFilteredStatus(facts);
    const tuple: MesStatusTuple = { scope: current.scope, phase: current.phase, required_skill: current.required_skill };
    // (PO-S06-B-01) The projection-only `project_terminal` adjunct (contracts
    // 2.3.1) is exposed by the PUBLIC status surface in BOTH sparse forms
    // (human + JSON) when a current cycle/terminal observation is provable —
    // not only in `--detail` (which already carries it through
    // projectCycleFilteredDetail / formatDetailStatus). Reuses the S06-A
    // projection seam (projectTerminalAdjunct); nothing is written, no
    // second store/pointer, no route/next-action (STATIC-14/30/31).
    const adjunct = projectTerminalAdjunct(facts);
    const result = options.detail
      ? options.jsonOutput
        ? projectCycleFilteredDetail(facts)
        : formatDetailStatus(projectCycleFilteredDetail(facts))
      : options.jsonOutput
        ? {
            ...projectSparseStatus(tuple),
            ...(adjunct !== undefined ? { project_terminal: adjunct } : {}),
          }
        : formatSparseStatus(projectSparseStatus(tuple)) +
          (adjunct !== undefined ? `\n${formatProjectTerminalAdjunct(adjunct)}` : '');
    return okEnvelope(command, result);
  } catch (error) {
    if (error instanceof MesStatusError && error.code === 'authority-gap') {
      return errorEnvelope(command, 'AUTHORITY_GAP', `cannot project cycle-filtered MES status: ${errorMessage(error)}`);
    }
    return errorEnvelope(command, 'RUNTIME.BLOCKED', `cannot project MES status: ${errorMessage(error)}`);
  }
}

function usageText(): string {
  return (
    'proofloop <domain> <operation> [--request <root-relative-json>] ' +
    '[--json <closed-json>] [--project-root <path>]'
  );
}

function usageEnvelope(message: string): CliEnvelope {
  return errorEnvelope(
    { domain: null, operation: null },
    'USAGE',
    `usage: ${usageText()}${message.length > 0 ? ` — ${message}` : ''}`,
  );
}

/**
 * Run the proofloop CLI for the given argv and return the exit code.
 * Prints exactly one canonical JSON envelope to stdout in every path.
 */
export function proofloopCli(
  argv: readonly string[],
  options: ProofloopCliOptions = {},
): number {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    emitEnvelope(usageEnvelope(errorMessage(error)));
    return CLI_EXIT.USAGE;
  }

  const command: CliCommand = {
    domain: parsed.positionals[0] ?? null,
    operation: parsed.positionals[1] ?? null,
  };

  if (parsed.help) {
    emitEnvelope(
      okEnvelope(command, { usage: usageText(), domains: [...CANONICAL_DOMAINS] }),
    );
    return CLI_EXIT.OK;
  }
  if (parsed.version) {
    emitEnvelope(okEnvelope(command, { version: PROOFLOOP_RUNTIME_VERSION }));
    return CLI_EXIT.OK;
  }

  // status: the ONLY read-only top-level observation entry. It is handled
  // BEFORE the closed-registry checks, never enters DOMAIN_REGISTRY /
  // CANONICAL_DOMAINS, accepts no request input, and never writes facts.
  if (parsed.positionals[0] === 'status') {
    const statusCommand: CliCommand = { domain: 'status', operation: null };
    if (parsed.positionals.length !== 1) {
      emitEnvelope(
        errorEnvelope(
          statusCommand,
          'RUNTIME.SCHEMA_MISMATCH',
          `status is a top-level read-only entry and takes no <operation> (received: ${parsed.positionals.slice(1).join(' ')})`,
        ),
      );
      return CLI_EXIT.BLOCKED;
    }
    if (parsed.stage !== undefined) {
      emitEnvelope(
        errorEnvelope(
          statusCommand,
          'RUNTIME.INPUT_INVALID',
          'status accepts no --stage scope selector; read the seeded status without a stage filter',
        ),
      );
      return CLI_EXIT.BLOCKED;
    }
    if (parsed.requestPath !== undefined || parsed.jsonInput !== undefined) {
      emitEnvelope(
        errorEnvelope(
          statusCommand,
          'RUNTIME.INPUT_INVALID',
          'status accepts no request input; use a bare --json for structured output',
        ),
      );
      return CLI_EXIT.BLOCKED;
    }
    let statusRoot: string;
    try {
      const explicitRoot = parsed.projectRoot ?? env[PROOFLOOP_ROOT_ENV];
      statusRoot = resolveTrustRoot({ explicitRoot, cwd }).root;
    } catch (error) {
      emitEnvelope(errorEnvelope(statusCommand, blockedCodeOf(error), errorMessage(error)));
      return CLI_EXIT.BLOCKED;
    }
    const statusEnvelope = runStatusDomain(statusRoot, {
      detail: parsed.detail ?? false,
      jsonOutput: parsed.jsonOutput ?? false,
    });
    emitEnvelope(statusEnvelope);
    return statusEnvelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }
  if (parsed.positionals.length < 2) {
    emitEnvelope(
      usageEnvelope(
        parsed.positionals.length === 0
          ? ''
          : `missing <operation> for domain "${parsed.positionals[0]}"`,
      ),
    );
    return CLI_EXIT.USAGE;
  }
  // Closed positional count — exactly <domain> <operation>; any extra
  // positional fails closed (exit 2) BEFORE the root assertion, the request
  // input read or any handler runs.
  if (parsed.positionals.length > 2) {
    emitEnvelope(
      errorEnvelope(
        command,
        'RUNTIME.SCHEMA_MISMATCH',
        `too many positional arguments: expected exactly "<domain> <operation>", received ${parsed.positionals.length} (${parsed.positionals.join(' ')})`,
      ),
    );
    return CLI_EXIT.BLOCKED;
  }

  // Canonical trust root assertion — before any artifact path/domain handling.
  let root: string;
  try {
    const explicitRoot = parsed.projectRoot ?? env[PROOFLOOP_ROOT_ENV];
    const resolution = resolveTrustRoot({ explicitRoot, cwd });
    root = resolution.root;
  } catch (error) {
    emitEnvelope(
      errorEnvelope(command, blockedCodeOf(error), errorMessage(error)),
    );
    return CLI_EXIT.BLOCKED;
  }

  // Closed domain/operation check: fail closed BEFORE any write and BEFORE
  // any request input read.
  const domain = command.domain as string;
  const operation = command.operation as string;
  if (!isCanonicalDomain(domain)) {
    emitEnvelope(
      errorEnvelope(
        command,
        'RUNTIME.SCHEMA_MISMATCH',
        `unknown domain "${domain}" (closed set: ${CANONICAL_DOMAINS.join('|')})`,
      ),
    );
    return CLI_EXIT.BLOCKED;
  }
  if (!isCanonicalOperation(domain, operation)) {
    emitEnvelope(
      errorEnvelope(
        command,
        'RUNTIME.SCHEMA_MISMATCH',
        `unknown operation "${operation}" for domain "${domain}" (closed set: ${DOMAIN_REGISTRY[domain].operations.join('|')})`,
      ),
    );
    return CLI_EXIT.BLOCKED;
  }

  // Closed request input: root-bound/no-follow `--request` file or inline
  // `--json`; unknown fields / conflicts fail closed BEFORE any handler runs
  // (dispatcher maps every failure to exit 2, no write).
  const requestValidation = resolveRequestInput(root, command, parsed);
  if (!requestValidation.ok) {
    emitEnvelope(errorEnvelope(command, requestValidation.code, requestValidation.message));
    return CLI_EXIT.BLOCKED;
  }

  // boundary: the mechanical deterministic Git adapter. It owns only
  // mechanical status/index/stage/commit/post-commit checks; Brain still owns
  // boundary selection and all recovery decisions.
  if (domain === 'boundary') {
    const envelope = runBoundaryDomain(root, command, requestValidation.request);
    emitEnvelope(envelope);
    return !envelope.ok && envelope.findings.some((finding) => finding.code === 'USAGE')
      ? CLI_EXIT.USAGE
      : envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  // integration: the dedicated mechanical Integration adapter. It is NOT a
  // `boundary close` boundary type; it owns only the deterministic Git
  // transaction (prechecks / candidate shape / stale-base / scope / conflict
  // precheck / staged apply / commit / post-commit). Brain still owns the
  // ready (CV PASS + durable candidate ref) and all recovery decisions.
  if (domain === 'integration') {
    const envelope = runIntegrationDomain(root, command, requestValidation.request);
    emitEnvelope(envelope);
    return !envelope.ok && envelope.findings.some((finding) => finding.code === 'USAGE')
      ? CLI_EXIT.USAGE
      : envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }
  // The closed operation is known but has no handler yet.
  emitEnvelope(
    errorEnvelope(
      command,
      'RUNTIME.NOT_IMPLEMENTED',
      `operation "${domain} ${operation}" is a closed command without a handler yet`,
    ),
  );
  return CLI_EXIT.BLOCKED;
}

if (require.main === module) {
  void (async () => {
    process.exitCode = await proofloopCli(process.argv.slice(2));
  })();
}