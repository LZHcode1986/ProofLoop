/**
 * Shared canonical Stage ID guard — S09-C-T03 tests.
 *
 * Every Runtime consumer (candidate parser, compiler, Mechanical Validator,
 * plan/stage/review status, admission) must apply the SAME closed grammar
 * `^S\d+$`.  Legacy parked labels such as S08B0 / S08B fail closed before
 * any Runtime read/write.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_STAGE_ID_RE,
  assertCanonicalStageId,
  isCanonicalStageId,
  VNextStageIdError,
} from './stage-id';

const LEGACY_LABELS = ['S08B0', 'S08B'];

describe('shared canonical Stage ID guard (S09-C-T03)', () => {
  it('exposes the single /^S\\d+$/ grammar to every Runtime consumer', () => {
    expect(CANONICAL_STAGE_ID_RE.source).toBe('^S\\d+$');
  });

  it('accepts canonical stage ids', () => {
    for (const stageId of ['S1', 'S09', 'S10', 'S123']) {
      expect(isCanonicalStageId(stageId)).toBe(true);
      expect(CANONICAL_STAGE_ID_RE.test(stageId)).toBe(true);
      expect(assertCanonicalStageId(stageId, 'stage_id')).toBe(stageId);
    }
  });

  it.each([
    'S08B0',
    'S08B',
    'S08-A',
    's09',
    'S',
    'S9.5',
    'S9_1',
    'S2/../../etc/passwd',
    'S2\\..\\..\\tmp',
    '9S',
    '',
  ])('rejects non-canonical stage id %j (legacy labels fail closed)', (stageId) => {
    expect(isCanonicalStageId(stageId)).toBe(false);
    expect(CANONICAL_STAGE_ID_RE.test(stageId)).toBe(false);
    expect(() => assertCanonicalStageId(stageId, 'stage_id')).toThrow(VNextStageIdError);
    expect(() => assertCanonicalStageId(stageId, 'stage_id')).toThrow(/canonical Stage ID/);
  });

  it('rejects legacy labels before any Runtime read/write with a bounded runtime error', () => {
    for (const legacy of LEGACY_LABELS) {
      try {
        assertCanonicalStageId(legacy, 'candidate.stage_id');
        throw new Error('expected assertCanonicalStageId to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(VNextStageIdError);
        if (error instanceof VNextStageIdError) {
          expect(error.label).toBe('candidate.stage_id');
          expect(error.message).toContain(legacy);
        }
      }
    }
  });
});
