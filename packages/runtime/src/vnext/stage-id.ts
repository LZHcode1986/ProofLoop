/**
 * Shared canonical Stage ID guard (S09-C-T03).
 *
 * Every Runtime consumer — candidate parser, compiler, Mechanical Validator,
 * plan/stage/review status and every admission seam — applies the SAME
 * closed grammar `^S\d+$` before touching a stage-named artifact.  Legacy
 * parked labels such as `S08B0` / `S08B` fail closed before any Runtime
 * read/write.
 *
 * The grammar authority lives in `@proofloop/kernel` (CANONICAL_STAGE_ID_RE);
 * this module is the single Runtime import path for that guard.
 */
import {
  assertCanonicalStageId as kernelAssertCanonicalStageId,
  isCanonicalStageId,
  CANONICAL_STAGE_ID_RE,
} from '@proofloop/kernel';

export { CANONICAL_STAGE_ID_RE, isCanonicalStageId };

/**
 * Bounded runtime error for a non-canonical Stage ID.  Carries the
 * consumer-facing field label so every Runtime boundary reports the same
 * fail-closed reason without leaking the kernel error vocabulary.
 */
export class VNextStageIdError extends Error {
  public readonly label: string;
  public readonly value: string;

  constructor(label: string, value: string) {
    super(
      `${label} "${value}" is not a canonical Stage ID (expected /^S\\d+$/, e.g. S09); ` +
        'legacy labels such as S08B0/S08B are rejected before any Runtime read/write',
    );
    this.name = 'VNextStageIdError';
    this.label = label;
    this.value = value;
  }
}

/**
 * Fail-closed canonical Stage ID assertion with a consumer-facing label.
 *
 * @returns the canonical Stage ID string on success.
 * @throws {VNextStageIdError} when the value is not a canonical Stage ID.
 */
export function assertCanonicalStageId(value: unknown, label = 'stage_id'): string {
  if (!isCanonicalStageId(value)) {
    throw new VNextStageIdError(label, typeof value === 'string' ? value : String(value));
  }
  void kernelAssertCanonicalStageId;
  return value;
}
