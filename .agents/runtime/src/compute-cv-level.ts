// compute-cv-level.ts
// 输入：Risk Facts 列表
// 输出：lite | standard | enhanced

export type CvLevel = 'lite' | 'standard' | 'enhanced';
export type RiskFact = string;

// ── Canonical risk fact definitions ──

/** Enhanced-level risk facts (any of these → 'enhanced'). */
export const ENHANCED_RISK_FACTS: readonly string[] = [
  'authorization',
  'migration',
  'concurrency',
  'irreversible_operation',
  'core_state_machine',
];

/** Standard-level risk facts (any of these, and no enhanced → 'standard'). */
export const STANDARD_RISK_FACTS: readonly string[] = [
  'persistent_state',
  'external_side_effect',
  'cross_process_behavior',
  'public_api_change',
];

/** All recognised risk fact enum values (including the sentinel 'none'). */
export const ALL_KNOWN_RISK_FACTS: ReadonlySet<string> = new Set([
  ...ENHANCED_RISK_FACTS,
  ...STANDARD_RISK_FACTS,
  'none',
]);

// ── Normalisation ──

/**
 * Normalise a raw risk fact string for matching against canonical values.
 *
 * Handles:
 * - Trailing colon: `authorization:` → `authorization`
 * - Colon with value: `authorization: true` → `authorization`
 * - Whitespace trimming
 * - Lowercasing
 */
export function normalizeRiskFact(fact: string): string {
  return fact
    .trim()
    .replace(/:$/, '')        // trailing colon only
    .replace(/:.*$/, '')      // colon followed by value
    .trim()
    .toLowerCase();
}

// ── CV level computation ──

/**
 * Compute the CV (Code Verifier) level based on declared Risk Facts.
 *
 * Rules:
 * - Any "enhanced" risk fact → 'enhanced'
 * - Any "standard" risk fact (and no enhanced) → 'standard'
 * - No matching risk facts → 'lite'
 */
export function computeCvLevel(riskFacts: RiskFact[]): CvLevel {
  // Normalise: trim whitespace, strip colons, lowercase for matching
  const normalised = riskFacts.map(f => normalizeRiskFact(f));

  // Reject any risk fact that is not in the known set
  for (const rf of normalised) {
    if (!ALL_KNOWN_RISK_FACTS.has(rf)) {
      throw new Error(`Unknown risk fact: "${rf}". Allowed: ${[...ALL_KNOWN_RISK_FACTS].join(', ')}`);
    }
  }

  const enhancedFacts = new Set(ENHANCED_RISK_FACTS);
  const standardFacts = new Set(STANDARD_RISK_FACTS);

  if (normalised.some(f => enhancedFacts.has(f))) return 'enhanced';
  if (normalised.some(f => standardFacts.has(f))) return 'standard';
  return 'lite';
}
