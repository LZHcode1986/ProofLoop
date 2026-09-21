/**
 * @proofloop/runtime — closed TASK_RESULT_ACK generation + idempotent-replay
 * mapping (S03-B-T02).
 *
 * Read-side closed mapping per contracts.md §4.3 / E2E-19 / FR-009 /
 * STATIC-14: input = the durable `result` kind facts (S03-A-T01's closed
 * result_id + result_payload_digest, consumed through the existing
 * `MesSnapshotStore.read` output) + the current submitted payload; output =
 * ACCEPT|REJECT + the closed ACK envelope. The module NEVER writes the store,
 * never creates an ack-log or a second result store, and the ACK itself is
 * non-durable transport/control — lost ACK / Brain restart re-derives the
 * equivalent ACK from durable facts.
 *
 * Closed ACK field set (worker-template / §4.3): kind / executionMode /
 * stageId / sliceId / taskId / actionToken / resultId / resultDisposition /
 * continuationDisposition / acceptedResultRef / validatedGitBasis /
 * reasonCode. Only ACCEPTED+CONTINUE / ACCEPTED+PAUSE / REJECTED+PAUSE are
 * legal; REJECTED+CONTINUE is invalid. `acceptedResultRef` is only allowed on
 * NORMAL+ACCEPTED and must resolve to a durably written MES `result` fact
 * belonging to THIS submission; PRE_MES_BOOTSTRAP and REJECTED forbid it.
 * `reasonCode` is required exactly when REJECTED or PAUSE and forbidden on
 * ACCEPTED+CONTINUE. `validatedGitBasis` equals the validated submitted
 * basis. The ACK never carries next_task_id / next_action /
 * recommended_action / producer instruction / Receipt / Gate.
 *
 * Payload decision is made over the durable result keys (resultId +
 * result_payload_digest), so replay is distinguishable after restart:
 *   - submitted digest == persisted digest → idempotent replay: equivalent
 *     ACCEPTED ACK, no duplicate TASK_COMPLETE (the original disposition is
 *     the durable ACCEPTED one; continuation is CONTINUE);
 *   - same resultId + different digest → RESULT_INVALID (no-write; the
 *     submitted payload is not the accepted payload);
 *   - durable duplicate resultId with conflicting digests (different fact_ids)
 *     → durable-state conflict: fail closed, no winner, no ACK ambiguity
 *     (typed RESULT_INVALID + recovery — Brain reviews durable facts);
 *   - same resultId + identical digest across different fact_ids → equivalent
 *     duplicate, deterministic merge (first durable fact in snapshot order);
 *   - the replay index covers ONLY `is_execute_result` facts; legacy S01
 *     result facts (`is_legacy_s01_result`) never enter the index and never
 *     create conflicts (predicate owned by S03-A-T01, consumed here);
 *   - stale actionToken → RESULT_BINDING_MISMATCH. The token is opaque input
 *     provided by Brain/Host; it is never derived from Link message id, Agent
 *     Name, pane/session or transport id (§4.3).
 */
import { isExecuteResult } from '../mes/validate';
import type { MesFactEnvelope, MesGitBasis } from '../mes/types';
import type { ValidatedWorkerTaskResult, TaskResultMode } from './task-result';

/** The single ACK kind (contracts.md §4.3 YAML). */
export const TASK_RESULT_ACK_KIND = 'TASK_RESULT_ACK' as const;

/** Closed result dispositions (contracts.md §4.3). */
export const ACK_RESULT_DISPOSITIONS = ['ACCEPTED', 'REJECTED'] as const;
export type AckResultDisposition = (typeof ACK_RESULT_DISPOSITIONS)[number];

/** Closed continuation dispositions (contracts.md §4.3). */
export const ACK_CONTINUATION_DISPOSITIONS = ['CONTINUE', 'PAUSE'] as const;
export type AckContinuationDisposition = (typeof ACK_CONTINUATION_DISPOSITIONS)[number];

/** Closed §7 typed outcomes this seam can raise. */
export type TaskResultAckCode = 'RESULT_INVALID' | 'RESULT_BINDING_MISMATCH';

/** Fail-closed typed error (no-write; recovery via durable facts + payload). */
export class TaskResultAckError extends Error {
  public readonly code: TaskResultAckCode;

  constructor(code: TaskResultAckCode, message: string) {
    super(message);
    this.name = 'TaskResultAckError';
    this.code = code;
    Object.setPrototypeOf(this, TaskResultAckError.prototype);
  }
}

/** Brain's decision input for a submission (§4.3 closed ACK fields). */
export interface TaskResultAckDecision {
  readonly resultDisposition: AckResultDisposition;
  readonly continuationDisposition: AckContinuationDisposition;
  /** NORMAL+ACCEPTED only; must be the durably written MES Result ref. */
  readonly acceptedResultRef?: string;
  /** Required exactly when REJECTED or PAUSE; forbidden on ACCEPTED+CONTINUE. */
  readonly reasonCode?: string;
}

/** Input to the read-side mapping. */
export interface TaskResultAckInput {
  /** The current Slice-lane token (opaque, Brain/Host-provided). */
  readonly laneActionToken: string;
  /** The submitted Task Result (already validated by the S03-B-T01 seam). */
  readonly submitted: ValidatedWorkerTaskResult;
  /** Brain decision for a fresh submission (durable facts govern replays). */
  readonly decision: TaskResultAckDecision;
  /** Durable facts from MesSnapshotStore.read() (never written here). */
  readonly durableFacts: readonly MesFactEnvelope[];
}

/** The closed ACK envelope (non-durable transport/control). */
export interface TaskResultAck {
  readonly kind: typeof TASK_RESULT_ACK_KIND;
  readonly executionMode: TaskResultMode;
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId?: string;
  readonly actionToken: string;
  readonly resultId: string;
  readonly resultDisposition: AckResultDisposition;
  readonly continuationDisposition: AckContinuationDisposition;
  readonly acceptedResultRef?: string;
  readonly validatedGitBasis: MesGitBasis;
  readonly reasonCode?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ackFail(code: TaskResultAckCode, message: string): never {
  throw new TaskResultAckError(code, message);
}

/**
 * Build the closed TASK_RESULT_ACK for a submission against the durable facts.
 *
 * @throws {TaskResultAckError} on any fail-closed condition (no ACK is
 *   produced, nothing is written — the caller never sends an ambiguous ACK).
 */
export function buildTaskResultAck(input: TaskResultAckInput): TaskResultAck {
  // 1) Closed input shape — unknown keys invalidate/no-write.
  if (!isObject(input)) {
    ackFail('RESULT_INVALID', 'TASK_RESULT_ACK input must be an object');
  }
  const inputRecord = input as unknown as Record<string, unknown>;
  const INPUT_FIELDS = new Set(['laneActionToken', 'submitted', 'decision', 'durableFacts']);
  for (const key of Object.keys(inputRecord)) {
    if (!INPUT_FIELDS.has(key)) {
      ackFail('RESULT_INVALID', `Unknown TASK_RESULT_ACK input field "${key}"`);
    }
  }
  if (!isObject(input.decision)) {
    ackFail('RESULT_INVALID', 'decision must be a closed object');
  }
  const decisionRecord = input.decision as unknown as Record<string, unknown>;
  const DECISION_FIELDS = new Set([
    'resultDisposition',
    'continuationDisposition',
    'acceptedResultRef',
    'reasonCode',
  ]);
  for (const key of Object.keys(decisionRecord)) {
    if (!DECISION_FIELDS.has(key)) {
      ackFail('RESULT_INVALID', `Unknown decision field "${key}"`);
    }
  }
  if (!Array.isArray(input.durableFacts)) {
    ackFail('RESULT_INVALID', 'durableFacts must be an array of MES fact envelopes');
  }
  if (typeof input.laneActionToken !== 'string' || input.laneActionToken.length === 0) {
    ackFail('RESULT_INVALID', 'laneActionToken must be a non-empty opaque token');
  }

  // 2) Submitted result must carry the fields this mapping reads (defensive;
  //    the B-T01 seam already validated it).
  const submitted = input.submitted;
  if (!isObject(submitted)) {
    ackFail('RESULT_INVALID', 'submitted must be a validated Worker Task Result');
  }
  const mode = submitted.executionMode;
  const resultId = submitted.resultId;
  const actionToken = submitted.actionToken;
  const gitBasis = submitted.gitBasis;
  const digest = submitted.resultPayloadDigest;
  if (
    (mode !== 'NORMAL' && mode !== 'PRE_MES_BOOTSTRAP' && mode !== 'MES_MAINTENANCE') ||
    typeof resultId !== 'string' ||
    resultId.length === 0 ||
    typeof actionToken !== 'string' ||
    actionToken.length === 0 ||
    !isObject(gitBasis) ||
    typeof gitBasis.head !== 'string' ||
    typeof gitBasis.branch !== 'string' ||
    typeof gitBasis.worktree !== 'string' ||
    typeof digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    ackFail('RESULT_INVALID', 'submitted Task Result is not a closed validated envelope');
  }
  // 2b) TASK_RESULT_ACK is a per-task control envelope: only the per-task
  //     shape (taskId present) may produce a Task ACK. slice-ready / repair
  //     are taskless non-ACK results and are rejected here (fail closed,
  //     no partial acceptance).
  if (submitted.subShape !== 'task') {
    ackFail(
      'RESULT_INVALID',
      'TASK_RESULT_ACK is only produced for a per-task submitted Result (slice-ready / repair are taskless non-ACK results)',
    );
  }

  // 3) Lane binding: the submitted token must be EXACTLY the current lane
  //    token (opaque input — never derived from Link/pane/session ids).
  if (actionToken !== input.laneActionToken) {
    ackFail(
      'RESULT_BINDING_MISMATCH',
      `stale actionToken: submitted token does not match the current Slice-lane token（§4.3，no-write）`,
    );
  }

  // 4) Closed decision combination (contracts.md §4.3).
  const disposition = input.decision.resultDisposition;
  const continuation = input.decision.continuationDisposition;
  if (
    (disposition !== 'ACCEPTED' && disposition !== 'REJECTED') ||
    (continuation !== 'CONTINUE' && continuation !== 'PAUSE')
  ) {
    ackFail('RESULT_INVALID', 'decision must carry closed disposition values');
  }
  if (disposition === 'REJECTED' && continuation === 'CONTINUE') {
    ackFail('RESULT_INVALID', 'REJECTED + CONTINUE is not a legal ACK combination（§4.3）');
  }
  const reasonCode = input.decision.reasonCode;
  const requiresReason = disposition === 'REJECTED' || continuation === 'PAUSE';
  if (requiresReason && reasonCode === undefined) {
    ackFail('RESULT_INVALID', 'reasonCode is required when REJECTED or PAUSE');
  }
  if (!requiresReason && reasonCode !== undefined) {
    ackFail('RESULT_INVALID', 'reasonCode is forbidden on ACCEPTED + CONTINUE');
  }
  const acceptedResultRef = input.decision.acceptedResultRef;
  const acceptedAllowed = mode === 'NORMAL' && disposition === 'ACCEPTED';
  if (!acceptedAllowed && acceptedResultRef !== undefined) {
    ackFail(
      'RESULT_INVALID',
      `acceptedResultRef is only allowed on NORMAL + ACCEPTED (mode=${mode}, disposition=${disposition})`,
    );
  }
  if (acceptedAllowed && acceptedResultRef === undefined) {
    ackFail('RESULT_INVALID', 'acceptedResultRef is required on NORMAL + ACCEPTED');
  }

  // 5) Replay index over the DURABLE facts: only is_execute_result facts
  //    (result_id + result_payload_digest) enter; legacy S01 facts never do.
  //    result_id → set of payload digests (duplicate fact_ids with identical
  //    digest merge deterministically; conflicting digests = durable-state
  //    conflict, fail closed with no winner).
  const replayIndex = new Map<string, Set<string>>();
  for (const fact of input.durableFacts) {
    if (!isExecuteResult(fact)) continue;
    if (typeof fact.result_id !== 'string') continue;
    const digests = replayIndex.get(fact.result_id) ?? new Set<string>();
    if (typeof fact.result_payload_digest === 'string') {
      digests.add(fact.result_payload_digest);
    }
    replayIndex.set(fact.result_id, digests);
  }

  // MES_MAINTENANCE ACKs are rebuilt from recovery Plan + Git refs/commits +
  // frozen/forensic/audit evidence (contracts §4.3) — never from the MES
  // durable result replay index, so the maintenance lane is exempt from the
  // NORMAL durable-result replay path (no second result store, no ack log).
  const indexEntry = mode === 'MES_MAINTENANCE' ? undefined : replayIndex.get(resultId);

  // 6a) Durable-state conflict: the same result_id is durably recorded with
  //     different payload digests — no winner, no ACK, no ambiguity.
  if (indexEntry !== undefined && indexEntry.size > 1) {
    ackFail(
      'RESULT_INVALID',
      `durable duplicate result_id ${JSON.stringify(resultId)} carries conflicting payload digests（契约 §7 RESULT_INVALID：durable-state conflict，no ACK；Brain reviews durable facts for recovery）`,
    );
  }

  // 6b) Idempotent replay / equivalent-ACK re-send (lost ACK, Brain restart):
  //     the submitted digest equals the persisted digest → the durable ACCEPTED
  //     disposition governs; no duplicate TASK_COMPLETE is implied.
  if (indexEntry !== undefined) {
    const persistedDigest = [...indexEntry][0];
    if (persistedDigest !== digest) {
      ackFail(
        'RESULT_INVALID',
        `same resultId ${JSON.stringify(resultId)} with a different payload digest（契约 §7 RESULT_INVALID：same id different payload，no-write）`,
      );
    }
    if (disposition === 'REJECTED') {
      ackFail(
        'RESULT_INVALID',
        `resultId ${JSON.stringify(resultId)} is durably accepted — the original ACCEPTED disposition governs and cannot be flipped to REJECTED（§4.3 idempotent replay，no ACK ambiguity）`,
      );
    }
    const durableFact = input.durableFacts.find(
      (fact) =>
        isExecuteResult(fact) &&
        fact.result_id === resultId &&
        fact.result_payload_digest === digest,
    );
    if (durableFact === undefined) {
      ackFail(
        'RESULT_INVALID',
        `durable result fact for resultId ${JSON.stringify(resultId)} is not re-readable`,
      );
    }
    const durableRef = durableFact.result_ref;
    if (mode === 'NORMAL' && (typeof durableRef !== 'string' || durableRef.length === 0)) {
      ackFail(
        'RESULT_INVALID',
        `durable result fact ${JSON.stringify(durableFact.fact_id)} has no result_ref for a NORMAL ACK`,
      );
    }
    if (acceptedResultRef !== undefined && acceptedResultRef !== durableRef) {
      ackFail(
        'RESULT_BINDING_MISMATCH',
        `acceptedResultRef ${JSON.stringify(acceptedResultRef)} does not equal the durable result_ref ${JSON.stringify(durableRef)} of the replayed fact`,
      );
    }
    return {
      kind: TASK_RESULT_ACK_KIND,
      executionMode: mode,
      stageId: submitted.stageId,
      sliceId: submitted.sliceId,
      ...(submitted.taskId !== undefined ? { taskId: submitted.taskId } : {}),
      actionToken,
      resultId,
      resultDisposition: 'ACCEPTED',
      continuationDisposition: continuation,
      ...(mode === 'NORMAL' ? { acceptedResultRef: durableRef } : {}),
      validatedGitBasis: gitBasis,
      ...(reasonCode !== undefined ? { reasonCode } : {}),
    };
  }

  // 6c) Fresh submission (result_id not durably recorded): the Brain decision
  //     governs. NORMAL + ACCEPTED additionally requires the acceptedResultRef
  //     to resolve to a durably written `result` fact belonging to THIS
  //     submission (result_id + digest equality) — acceptance is only formed
  //     after the durable write, never before it.
  if (acceptedAllowed) {
    const durableRef = acceptedResultRef as string;
    const backingFact = input.durableFacts.find(
      (fact) => fact.fact_kind === 'result' && fact.result_ref === durableRef,
    );
    if (backingFact === undefined) {
      ackFail(
        'RESULT_INVALID',
        `acceptedResultRef ${JSON.stringify(durableRef)} must resolve to a durably written MES result fact（acceptedResultRef 必须为已 durable 写入的 MES Result ref）`,
      );
    }
    if (
      backingFact.result_id !== resultId ||
      backingFact.result_payload_digest !== digest
    ) {
      ackFail(
        'RESULT_BINDING_MISMATCH',
        `the durable result fact ${JSON.stringify(backingFact.fact_id)} backing acceptedResultRef does not belong to this submission（result_id / result_payload_digest mismatch）`,
      );
    }
  }

  return {
    kind: TASK_RESULT_ACK_KIND,
    executionMode: mode,
    stageId: submitted.stageId,
    sliceId: submitted.sliceId,
    ...(submitted.taskId !== undefined ? { taskId: submitted.taskId } : {}),
    actionToken,
    resultId,
    resultDisposition: disposition,
    continuationDisposition: continuation,
    ...(acceptedResultRef !== undefined ? { acceptedResultRef } : {}),
    validatedGitBasis: gitBasis,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
  };
}
