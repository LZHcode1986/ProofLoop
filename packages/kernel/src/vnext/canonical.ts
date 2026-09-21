/**
 * @proofloop/kernel — canonicalization & digest utilities.
 *
 * Deterministic UTF-8 / canonical-JSON hashing for vNext digests.
 * `canonicalJson` is the SINGLE canonicalization rule used by every kernel
 * digest: v1 Receipt digests and vNext digests always shared one
 * canonicalization rule (§8 plan_digest: "由规范化 Plan AST 计算，而不是对
 * 完整 Markdown 字节计算"), and after the neutral cutover that rule lives
 * here, exactly once.
 */
import { createHash } from 'node:crypto';

/**
 * Serializes a value to canonical JSON with deterministically sorted keys.
 *
 * Uses a recursive approach: objects are serialized with their keys sorted
 * lexicographically so the same logical data always produces the same string
 * representation. This is essential for content-addressed digests.
 *
 * @param value - The value to serialize.
 * @returns Canonical JSON string.
 *
 * @throws {TypeError} if the value contains non-JSON types (symbol, bigint,
 *   function) or non-finite numbers — fail closed, never hash ambiguous data.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    // NaN and Infinity are not valid JSON values — reject them early
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Cannot canonicalize non-finite number: ${value}`,
      );
    }
    return String(value);
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item));
    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${pairs.join(',')}}`;
  }

  // Fallback for any other type (symbol, bigint, function, etc.)
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

/**
 * SHA-256 over UTF-8 bytes, lowercase hex (64 chars).
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Canonical JSON + SHA-256 digest of any JSON-serializable value.
 *
 * Deterministic: identical logical data always yields the same digest
 * (canonicalJson sorts object keys and normalizes primitives).
 *
 * @throws {TypeError} if the value contains non-JSON types (symbol, bigint,
 *   function) or non-finite numbers — fail closed, never hash ambiguous data.
 */
export function computeDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Lowercase 64-char hex SHA-256 shape. */
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * True when the value is a lowercase 64-char hex SHA-256 digest string.
 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

/**
 * Canonical entity-reference grammar (§7.6 Reference Grammar):
 *   <root-relative-path>#/entities/<entity-id>
 * or for JSON artifacts:
 *   <root-relative-path>#/<json-pointer>
 */
export const VNEXT_REF_GRAMMAR_RE = /^[^#\s]+\#[^\s]+$/;