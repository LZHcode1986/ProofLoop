// compute-scv-level.ts
// 输入：Risk Facts 列表
// 输出：lite | standard | enhanced

export type ScvLevel = 'lite' | 'standard' | 'enhanced';
export type RiskFact = string;

/**
 * Compute the SCV (Slice Code Verification) level based on declared Risk Facts.
 *
 * Rules:
 * - Any "enhanced" risk fact → 'enhanced'
 * - Any "standard" risk fact (and no enhanced) → 'standard'
 * - No matching risk facts → 'lite'
 *
 * Enhanced-level risk facts:
 *   authorization, migration, concurrency, irreversible_operation, core_state_machine
 *
 * Standard-level risk facts:
 *   persistent_state, external_side_effect, cross_process_behavior
 */
export function computeScvLevel(riskFacts: RiskFact[]): ScvLevel {
  // Normalise: trim whitespace and lowercase for matching
  const normalised = riskFacts.map(f => f.trim().toLowerCase());

  // 以下 risk fact 中任意一个存在 → enhanced
  const enhancedFacts = new Set([
    'authorization',
    'migration',
    'concurrency',
    'irreversible_operation',
    'core_state_machine',
  ]);

  // 以下 risk fact 中任意一个存在 → standard（除非已 enhanced）
  const standardFacts = new Set([
    'persistent_state',
    'external_side_effect',
    'cross_process_behavior',
  ]);

  if (normalised.some(f => enhancedFacts.has(f))) return 'enhanced';
  if (normalised.some(f => standardFacts.has(f))) return 'standard';
  return 'lite';
}
