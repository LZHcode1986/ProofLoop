/**
 * worker-step-service.ts — WorkerStepService (PO-S02-B-02 / PO-S02-B-03)
 *
 * The runtime's ONLY worker step execution seam (AWI-021): the Executor hands
 * a worker action indication plus the caller-supplied dispatch context, and
 * the service builds the canonical `WorkerDispatchPacket` (protocolVersion: 1,
 * resultContract.schemaVersion: 1 — Blueprint §12) and relays it through the
 * constructor-injected `WorkerRelayPort` (executeStep exactly once / signal
 * passthrough / invalidateSlice verbatim forward).
 *
 * Zero host imports (ADR-012 / AWI-024 / HP-010): the service depends only on
 * the abstract port types from ./relay-contract — it never imports or
 * references any host (pi-subagents) implementation, never touches relay
 * internals (no filesystem reads, no parsing of host run/session identifiers;
 * relay diagnostics stay opaque per Blueprint #9.6 / #11 / #22).
 */

import type {
  WorkerRelayPort,
  WorkerRelayStepInput,
  WorkerRelayStepResult,
  WorkerDispatchPacket,
  WorkerSliceInvalidation,
  WorkerStepMode,
  WorkerContinuation,
} from './relay-contract';

/**
 * Caller-supplied context for one worker step dispatch.
 *
 * `stageId` / `sliceId` / `taskId?` / `mode` / `continuation` / `timeoutMs`
 * are the worker action indication; `actionToken`, `authorityRefs`, `git`,
 * `scope` and `resultContract` are supplied by the caller and bound into the
 * packet verbatim (no alias, no added or dropped field).
 */
export interface WorkerStepDispatchInput {
  readonly projectRoot: string;
  readonly parentSessionId: string;
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId?: string;
  readonly mode: WorkerStepMode;
  readonly continuation: WorkerContinuation;
  readonly timeoutMs: number;
  readonly actionToken: string;
  readonly authorityRefs: WorkerDispatchPacket['authorityRefs'];
  readonly git: WorkerDispatchPacket['git'];
  readonly scope: WorkerDispatchPacket['scope'];
  readonly resultContract: WorkerDispatchPacket['resultContract'];
}

/**
 * WorkerStepService — executes worker steps ONLY through the injected
 * `WorkerRelayPort`.
 *
 * - `executeStep` constructs the protocolVersion-1 `WorkerDispatchPacket` and
 *   calls the port's `executeStep` exactly once (there is no fallback path
 *   and no direct success return), passing the caller's `AbortSignal`
 *   through; the port's normalized `WorkerRelayStepResult` is returned
 *   unchanged.
 * - `invalidateSlice` forwards projectRoot / parentSessionId / stageId /
 *   sliceId to the port verbatim; the service itself never holds or parses
 *   any host run/session identifier.
 */
export class WorkerStepService {
  private readonly port: WorkerRelayPort;

  constructor(port: WorkerRelayPort) {
    this.port = port;
  }

  executeStep(
    input: WorkerStepDispatchInput,
    signal?: AbortSignal,
  ): Promise<WorkerRelayStepResult> {
    const packet: WorkerDispatchPacket = {
      protocolVersion: 1,
      actionToken: input.actionToken,
      stageId: input.stageId,
      sliceId: input.sliceId,
      taskId: input.taskId,
      mode: input.mode,
      authorityRefs: input.authorityRefs,
      git: input.git,
      scope: input.scope,
      resultContract: input.resultContract,
    };

    const relayInput: WorkerRelayStepInput = {
      projectRoot: input.projectRoot,
      parentSessionId: input.parentSessionId,
      stageId: input.stageId,
      sliceId: input.sliceId,
      taskId: input.taskId,
      mode: input.mode,
      actionToken: input.actionToken,
      packet,
      continuation: input.continuation,
      timeoutMs: input.timeoutMs,
    };

    return this.port.executeStep(relayInput, signal);
  }

  invalidateSlice(input: WorkerSliceInvalidation): Promise<void> {
    return this.port.invalidateSlice(input);
  }
}
