import { createHash } from 'node:crypto';
export function computeCanonicalJsonDigest(schema, value) {
    const parsed = schema.parse(value);
    // Recursively sort object keys
    const sorted = sortKeys(parsed);
    const json = JSON.stringify(sorted);
    return createHash('sha256').update(json, 'utf-8').digest('hex').slice(0, 16);
}
function sortKeys(obj) {
    if (obj === null || typeof obj !== 'object')
        return obj;
    if (Array.isArray(obj))
        return obj.map(sortKeys);
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
}
//# sourceMappingURL=canonical-digest.js.map