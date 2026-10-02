/**
 * @proofloop/runtime — typed MES semantic-event materialization failure.
 *
 * Extracted into its own module so the ONE mechanical event catalog and the
 * per-family handler modules can raise typed no-write failures without
 * importing the materializer itself (which composes them and would otherwise
 * create a module cycle).
 *
 * The code set is CLOSED: a new family may only reuse these codes, never add a
 * new failure vocabulary. Nothing in this module decides route, repair,
 * Replan, next Task, next Stage or next action.
 */

/** Closed materialization failure codes (fail closed, never partial). */
export type MesMaterializationErrorCode =
  | 'invalid-event' // event/binding shape invalid (unknown keys, non-NORMAL mode, bad refs)
  | 'invalid-field' // payload carries an unknown / forbidden / missing caller field
  | 'unsupported-event-kind' // event kind is not in the mechanical catalog
  | 'invalid-derived-fact' // a Runtime-derived fact fails envelope/ownership validation
  | 'binding-mismatch' // current-relation resolution / exact-match gate failed
  | 'conflict' // same durable fact_id with a different payload
  | 'unreadable' // current snapshot unreadable / corrupt → no-write
  | 'persist-failed' // atomic persist failed
  | 'escape'; // root escapes the trust boundary

/** Bounded materialization error raised on any fail-closed condition. */
export class MesMaterializationError extends Error {
  public readonly code: MesMaterializationErrorCode;
  public readonly eventKind: string | undefined;

  constructor(code: MesMaterializationErrorCode, message: string, eventKind?: string) {
    super(message);
    this.name = 'MesMaterializationError';
    this.code = code;
    this.eventKind = eventKind;
  }
}

/** Fail closed: raise the bounded typed error and never return a partial result. */
export function materializeFail(
  code: MesMaterializationErrorCode,
  message: string,
  eventKind?: string,
): never {
  throw new MesMaterializationError(code, message, eventKind);
}
