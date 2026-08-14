/**
 * @proofloop/kernel — vNext canonicalization & digest utilities (S0-A).
 *
 * Deterministic UTF-8 / canonical-JSON hashing for vNext digests.
 * Reuses the kernel's existing canonical JSON serializer (receipt-writer)
 * so v1 and vNext share ONE canonicalization rule (§8 plan_digest:
 * "由规范化 Plan AST 计算，而不是对完整 Markdown 字节计算").
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../receipt-writer';

/** Re-export the shared canonical JSON serializer. */
export { canonicalJson };

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
