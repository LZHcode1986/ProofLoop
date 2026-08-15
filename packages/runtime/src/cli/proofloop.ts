#!/usr/bin/env node
/**
 * proofloop.ts — S10-A-T01: public proofloop CLI dispatcher (seam base).
 *
 *   proofloop <domain> <operation> [--request <root-relative-json>]
 *            [--json <closed-json>] [--project-root <path>]
 *
 * Contract (tech-spec §0.1/§0.2/§0.3, Acceptance A):
 *  - stdout carries exactly ONE canonical JSON envelope; no natural-language
 *    prefix on success or refusal;
 *  - exit: 0 = completed/read-ready, 1 = usage/schema/runtime failure,
 *    2 = structured blocked/refused/no-write;
 *  - domain/operation come from the closed §0.3 registry; unknown domain or
 *    operation fails closed (RUNTIME.SCHEMA_MISMATCH, exit 2) BEFORE any
 *    filesystem write and BEFORE any request input read;
 *  - the canonical trust root is asserted before any artifact path is used;
 *    `--project-root` is a consistency assertion, never an override;
 *  - the CLI never imports a harness SDK and never writes Receipts/Manifest/
 *    Context/Evidence directly.
 *
 * S10-A-T01 delivered the base: registry + envelope + exit contract + root
 * assertion + request-input base parsing.  S10-A-T02 registers the doctor
 * domain handler and completes the request-file/JSON closed input; later
 * Slices register the remaining domains.
 */

import { runDoctor, runDoctorStatus } from './proofloop-doctor';
import { collectPlanParams, runAuthorityCheck, runPlan } from './proofloop-plan';
import { collectContextParams, runContext } from './proofloop-context';
import { collectStageParams, runStage } from './proofloop-stage';
import { collectGateParams, runGateDomain } from './proofloop-gate';
import { collectReviewParams, runReview } from './proofloop-review';
import { collectProjectParams, runProjectDomain } from './proofloop-project';
import { collectRecoveryParams, runRecoveryDomain } from './proofloop-recovery';
import { runCutoverDomain } from './proofloop-cutover';
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
 *
 * Overload note: the public signature stays `number` (the in-process seam
 * contract consumed by the CLI specs).  The implementation may return
 * `Promise<number>` for the gate domain, whose handler is async (real
 * canonical proof step execution + CLI→Runtime GATE_PASS admission); the
 * built-process main entry awaits the result so the exit code always follows
 * `envelope.ok` (0) / blocked (2).
 */
export function proofloopCli(
  argv: readonly string[],
  options?: ProofloopCliOptions,
): number;
export function proofloopCli(
  argv: readonly string[],
  options: ProofloopCliOptions = {},
): number | Promise<number> {
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
  // CV repair: closed positional count — exactly <domain> <operation>; any
  // extra positional fails closed (exit 2) BEFORE the root assertion, the
  // request input read or any handler runs.
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
  let rootSource: 'explicit' | 'auto';
  try {
    const explicitRoot = parsed.projectRoot ?? env[PROOFLOOP_ROOT_ENV];
    const resolution = resolveTrustRoot({ explicitRoot, cwd });
    root = resolution.root;
    rootSource = resolution.source;
  } catch (error) {
    emitEnvelope(
      errorEnvelope(command, blockedCodeOf(error), errorMessage(error)),
    );
    return CLI_EXIT.BLOCKED;
  }

  // Closed domain/operation check: fail closed BEFORE any write and BEFORE
  // any request input read (§0.3).
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

  // Closed request input (S10-A-T02): root-bound/no-follow `--request` file
  // or inline `--json`; unknown fields / conflicts fail closed BEFORE any
  // handler runs (dispatcher maps every failure to exit 2, no write).
  const requestValidation = resolveRequestInput(root, command, parsed);
  if (!requestValidation.ok) {
    emitEnvelope(errorEnvelope(command, requestValidation.code, requestValidation.message));
    return CLI_EXIT.BLOCKED;
  }

  // Domain handler dispatch (S10-A-T02 registers doctor; S10-B-T01 registers
  // the plan/authority domains; S10-C-T01 registers the stage domain; later
  // Slices register the remaining closed domains).
  if (domain === 'doctor' && operation === 'run') {
    emitEnvelope(runDoctor(root, rootSource, command));
    return CLI_EXIT.OK;
  }

  // S10-D-T03: doctor status — 只读状态报告（Git/capabilities/版本/schema +
  // receipts 类别摘要）；非 git 仓库降级报告（git.available: false）exit 0，
  // 零写入。
  if (domain === 'doctor' && operation === 'status') {
    emitEnvelope(runDoctorStatus(root, rootSource, command));
    return CLI_EXIT.OK;
  }

  if (domain === 'plan') {
    const envelope = runPlan(root, rootSource, command, collectPlanParams(parsed, requestValidation.request));
    emitEnvelope(envelope);
    return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  if (domain === 'authority' && operation === 'check') {
    const envelope = runAuthorityCheck(root, rootSource, command, collectPlanParams(parsed, requestValidation.request));
    emitEnvelope(envelope);
    return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  if (domain === 'context') {
    const envelope = runContext(root, rootSource, command, collectContextParams(parsed, requestValidation.request));
    emitEnvelope(envelope);
    return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  if (domain === 'stage') {
    const envelope = runStage(root, rootSource, command, collectStageParams(parsed, requestValidation.request));
    emitEnvelope(envelope);
    return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  // S10-C-T02: gate domain — the handler is async (real canonical proof step
  // execution + CLI→Runtime GATE_PASS admission), so this branch returns a
  // promise; the envelope is emitted after the handler resolves.
  if (domain === 'gate') {
    return runGateDomain(
      root,
      rootSource,
      command,
      collectGateParams(parsed, requestValidation.request),
    ).then((envelope) => {
      emitEnvelope(envelope);
      return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
    });
  }

  // S10-D-T01: review domain — status/prepare-stage 只读投影，finalize-stage
  // CLI→Runtime review admission（verdict + summary）。成功 exit 0；所有
  // structured failure（含 finalize 拒绝与 Receipt 链破坏）exit 2。
  if (domain === 'review') {
    const envelope = runReview(root, rootSource, command, collectReviewParams(parsed, requestValidation.request));
    emitEnvelope(envelope);
    return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  // S10-D-T02: project domain — status/compile-acceptance/run-e2e/
  // prepare-review/finalize-review（project 域全局，无 --stage）。run-e2e 是
  // 异步操作（真实 E2E step 执行 + seam 写 Project E2E Gate Receipt），故
  // 本分支与 gate 域同构返回 promise；envelope 在 handler resolve 后 emit。
  // 成功 exit 0；所有 structured failure（含 E2E FAIL、finalize 拒绝与
  // Receipt 链破坏）exit 2。
  if (domain === 'project') {
    return runProjectDomain(
      root,
      rootSource,
      command,
      collectProjectParams(parsed, requestValidation.request),
    ).then((envelope) => {
      emitEnvelope(envelope);
      return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
    });
  }

  // S10-D-T03: recovery domain — check/preflight 只读恢复状态报告与预检，
  // restart 复用 vNext restart/recovery seam（只从本地持久事实重新投影派发
  // 状态，Context 由 Runtime next seam 落盘，不重放 Worker 实现），doctor
  // 转发 doctor 域能力。成功 exit 0；所有 structured failure（含 VALIDATE
  // 前置、Manifest/authority 缺失与事实破坏）exit 2。
  if (domain === 'recovery') {
    const envelope = runRecoveryDomain(root, rootSource, command, collectRecoveryParams(parsed, requestValidation.request));
    emitEnvelope(envelope);
    return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  // S10-E-T02 repair: cutover domain — status 只读 legacy scan（cutover
  // matrix）；execute 带 irreversible 保护语义（confirmed + 精确
  // delete_list 绑定 + Acceptance A–E 事实验证 + 原子预检），未授权 fail
  // closed（exit 2，零删除）。与 S10-C/D 各域同构的 public 域。
  if (domain === 'cutover') {
    const envelope = runCutoverDomain(root, command, requestValidation.request);
    emitEnvelope(envelope);
    return envelope.ok ? CLI_EXIT.OK : CLI_EXIT.BLOCKED;
  }

  // The closed operation is known but has no handler yet (later Slices).
  emitEnvelope(
    errorEnvelope(
      command,
      'RUNTIME.NOT_IMPLEMENTED',
      `operation "${domain} ${operation}" is a closed command without a handler yet (S10-A-T03+)`,
    ),
  );
  return CLI_EXIT.BLOCKED;
}

if (require.main === module) {
  void (async () => {
    process.exitCode = await proofloopCli(process.argv.slice(2));
  })();
}
