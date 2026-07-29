import { computeCvLevel } from '../src/compute-cv-level.js';

describe('computeCvLevel', () => {
  test('authorization → enhanced', () => {
    expect(computeCvLevel(['authorization'])).toBe('enhanced');
  });

  test('persistent_state → standard', () => {
    expect(computeCvLevel(['persistent_state'])).toBe('standard');
  });

  test('no risk facts → lite', () => {
    expect(computeCvLevel([])).toBe('lite');
  });

  test('none → lite', () => {
    expect(computeCvLevel(['none'])).toBe('lite');
  });

  test('authorization: (colon suffix) → enhanced after normalisation', () => {
    // normalizeRiskFact strips trailing colon, so "authorization:" → "authorization"
    expect(computeCvLevel(['authorization:'])).toBe('enhanced');
  });

  test('public_api_change → standard', () => {
    expect(computeCvLevel(['public_api_change'])).toBe('standard');
  });

  test('unknown risk fact → throws', () => {
    expect(() => computeCvLevel(['unknown_risk_xyz'])).toThrow(/Unknown risk fact/);
  });

  test('mixed enhanced overrides standard', () => {
    // Both enhanced and standard present → enhanced wins
    expect(computeCvLevel(['persistent_state', 'authorization'])).toBe('enhanced');
  });

  test('multiple standard facts → standard', () => {
    expect(computeCvLevel(['external_side_effect', 'cross_process_behavior'])).toBe('standard');
  });
});
