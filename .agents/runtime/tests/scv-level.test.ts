import { computeScvLevel } from '../src/compute-scv-level.js';

describe('computeScvLevel', () => {
  test('authorization → enhanced', () => {
    expect(computeScvLevel(['authorization'])).toBe('enhanced');
  });

  test('persistent_state → standard', () => {
    expect(computeScvLevel(['persistent_state'])).toBe('standard');
  });

  test('no risk facts → lite', () => {
    expect(computeScvLevel([])).toBe('lite');
  });

  test('none → lite', () => {
    expect(computeScvLevel(['none'])).toBe('lite');
  });

  test('authorization: (colon suffix) → enhanced after normalisation', () => {
    // normalizeRiskFact strips trailing colon, so "authorization:" → "authorization"
    expect(computeScvLevel(['authorization:'])).toBe('enhanced');
  });

  test('public_api_change → standard', () => {
    expect(computeScvLevel(['public_api_change'])).toBe('standard');
  });

  test('unknown risk fact → throws', () => {
    expect(() => computeScvLevel(['unknown_risk_xyz'])).toThrow(/Unknown risk fact/);
  });

  test('mixed enhanced overrides standard', () => {
    // Both enhanced and standard present → enhanced wins
    expect(computeScvLevel(['persistent_state', 'authorization'])).toBe('enhanced');
  });

  test('multiple standard facts → standard', () => {
    expect(computeScvLevel(['external_side_effect', 'cross_process_behavior'])).toBe('standard');
  });
});
