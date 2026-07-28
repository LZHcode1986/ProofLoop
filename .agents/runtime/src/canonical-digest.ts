import { createHash } from 'node:crypto';
import { z } from 'zod';

export function computeCanonicalJsonDigest<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): string {
  const parsed = schema.parse(value);
  // Recursively sort object keys
  const sorted = sortKeys(parsed);
  const json = JSON.stringify(sorted);
  return createHash('sha256').update(json, 'utf-8').digest('hex').slice(0, 16);
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}
