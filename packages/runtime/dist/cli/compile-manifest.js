"use strict";
/**
 * compile-manifest — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * `tasks.md` → a canonical Manifest that passes the kernel `validateManifest`
 * seam (fail closed: an invalid manifest is never emitted). Parameter
 * contract matches the legacy CLI:
 *
 *   node packages/runtime/dist/cli/compile-manifest.js <tasks-path> <output-manifest-path>
 *
 * Multi-slice dependency list parsing: each slice's `### Dependencies` list
 * item may declare one dependency per line (`- S03-A`) or multiple
 * dependencies per line (`- S03-A S03-B`); every whitespace-separated token
 * matching the slice-id pattern is a dependency, so the machine-readable DAG
 * equals the tasks.md declarations (declaration order preserved). Prose-only
 * items produce no dependency (never a guess).
 *
 * The `## Stage Runtime Proof` section is parsed from the documented YAML
 * subset used by the Stage tasks (steps flow list; scalar fields; flow args
 * arrays with quoted elements; nested `expected:` / `not_applicable:`
 * maps). No third-party YAML dependency is introduced (zero host deps,
 * AWI-024/ADR-012 — stdlib only).
 *
 * Zero host dependencies: imports only Node builtins, `@proofloop/kernel`
 * and package-internal modules.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_KNOWN_RISK_FACTS = void 0;
exports.extractSection = extractSection;
exports.extractListItems = extractListItems;
exports.parseSliceDependencies = parseSliceDependencies;
exports.normalizeRiskFact = normalizeRiskFact;
exports.computeCvMinimumLevel = computeCvMinimumLevel;
exports.parseRuntimeProofSteps = parseRuntimeProofSteps;
exports.compileManifest = compileManifest;
exports.compileManifestCli = compileManifestCli;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const kernel_1 = require("@proofloop/kernel");
// ============================================================
// Markdown section helpers
// ============================================================
/**
 * Extract the content of a Markdown section by heading (## or ###).
 * The heading text must match exactly after trimming (e.g. `### Goal`).
 */
function extractSection(lines, heading) {
    const startIdx = lines.findIndex((l) => {
        const trimmed = l.trim();
        const match = trimmed.match(/^#{2,3}\s+(.+)/);
        return match !== null && match[1].trim() === heading;
    });
    if (startIdx === -1)
        return '';
    const rest = lines.slice(startIdx + 1);
    const endIdx = rest.findIndex((l) => /^#{1,3}\s/.test(l.trim()));
    return endIdx === -1 ? rest.join('\n').trim() : rest.slice(0, endIdx).join('\n').trim();
}
/** Extract `- item` list items from text. */
function extractListItems(text) {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).trim())
        .filter(Boolean);
}
/** First paragraph of a section (non-empty, non-heading lines joined). */
function extractFirstParagraph(text) {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))
        .join(' ')
        .trim();
}
/**
 * Extract slice regions from `<!-- SLICE:<id>:BEGIN -->` / `:END -->`
 * markers (declaration order). Structural marker errors fail closed.
 */
function extractSliceRegions(text) {
    const regions = [];
    const lines = text.split('\n');
    let current = null;
    for (const line of lines) {
        const begin = line.match(/<!--\s*SLICE:(\S+):BEGIN\s*-->/);
        const end = line.match(/<!--\s*SLICE:(\S+):END\s*-->/);
        if (begin) {
            if (current !== null) {
                throw new Error(`Slice region "${begin[1]}" opened while "${current.sliceId}" is still open (nested or missing END marker)`);
            }
            current = { sliceId: begin[1], lines: [] };
            continue;
        }
        if (end) {
            if (current === null) {
                throw new Error(`Orphaned SLICE:${end[1]}:END marker without a matching BEGIN`);
            }
            if (current.sliceId !== end[1]) {
                throw new Error(`Mismatched SLICE:END for "${end[1]}" while "${current.sliceId}" region is open`);
            }
            regions.push(current);
            current = null;
            continue;
        }
        if (current !== null)
            current.lines.push(line);
    }
    if (current !== null) {
        throw new Error(`Unclosed slice region: "${current.sliceId}" (missing END marker)`);
    }
    return regions;
}
// ============================================================
// Multi-slice dependency list parsing
// ============================================================
const SLICE_ID_RE = /^S\d{2,}-[A-Z]$/;
/**
 * Separator tokens tolerated between slice ids in a dependency list item
 * (e.g. `- S03-A + S03-B`). Prose tokens terminate the leading run.
 */
const DEP_SEPARATORS = new Set(['+', '&', ',', '/', '和']);
/**
 * Parse a slice dependency list. Each `- ` list item may declare one
 * dependency per line (`- S03-A`) or multiple dependencies per line
 * (`- S03-A S03-B`, optionally separated by `+`/`&`/`,`/`/`). Only the
 * LEADING run of slice-id/separator tokens counts — description prose that
 * merely mentions another slice id (e.g. "经 S03-F 传递") is never parsed as
 * a dependency (never a guess; declaration order preserved).
 */
function parseSliceDependencies(text) {
    const deps = [];
    for (const item of extractListItems(text)) {
        for (const token of item.split(/\s+/)) {
            if (SLICE_ID_RE.test(token)) {
                deps.push(token);
                continue;
            }
            if (DEP_SEPARATORS.has(token))
                continue;
            break; // first prose token ends the leading dependency run
        }
    }
    return deps;
}
// ============================================================
// Task ids
// ============================================================
/** Extract task ids from checkbox lines (`- [x] S03-H-T01 ...`). */
function extractTaskIds(text) {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/.test(l))
        .map((l) => {
        const match = l.match(/- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/);
        return match ? match[1] : '';
    })
        .filter(Boolean);
}
// ============================================================
// Proof obligations
// ============================================================
/** Normalize a PO field key: lowercase, non-alphanumeric runs → '_'. */
function normalizePoKey(key) {
    return key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
/**
 * Parse `- Key: value` fields of a PO block, joining indented continuation
 * lines so multi-line values (e.g. long Behavior prose) are preserved.
 */
function parsePoFields(block) {
    const fields = new Map();
    const parts = new Map();
    let currentKey = null;
    for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        const fieldMatch = trimmed.match(/^-\s+(.+?):\s*(.*)$/);
        if (fieldMatch) {
            currentKey = normalizePoKey(fieldMatch[1]);
            parts.set(currentKey, fieldMatch[2] ? [fieldMatch[2]] : []);
            continue;
        }
        if (currentKey !== null && !trimmed.startsWith('-')) {
            parts.get(currentKey)?.push(trimmed);
        }
    }
    for (const [key, values] of parts) {
        fields.set(key, values.join(' '));
    }
    return fields;
}
/** Split a comma-separated applicable-risk-fact value. */
function splitRiskFactList(value) {
    return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}
/**
 * Parse the `### Proof Obligations` section into kernel-valid ProofObligation
 * entries. Missing fields get explicit non-empty defaults (kernel requires
 * non-empty strings; never a silent guess).
 */
function parseProofObligations(section, defaultPublicSeam) {
    const poBlocks = ('\n' + section).split(/\n\s*-\s*PO-/).slice(1);
    const result = [];
    for (const rawBlock of poBlocks) {
        const fullBlock = 'PO-' + rawBlock;
        const poIdMatch = fullBlock.match(/^(PO-S\d{2,}-[A-Z]-\d{2})/);
        if (!poIdMatch)
            continue;
        const fields = parsePoFields(fullBlock);
        result.push({
            po_id: poIdMatch[1],
            behavior: fields.get('behavior') || '(not declared)',
            public_seam: fields.get('public_seam') || defaultPublicSeam || '(not declared)',
            oracle_source: fields.get('oracle_source') || '(not declared)',
            success_criteria: fields.get('success_failure') || '(not declared)',
            required_observation: fields.get('required_observation') || '(not declared)',
            applicable_risk_facts: fields.has('applicable_risk_facts')
                ? splitRiskFactList(fields.get('applicable_risk_facts') ?? '')
                : [],
        });
    }
    return result;
}
// ============================================================
// CV minimum level (canonical Risk Fact → level mapping)
// ============================================================
const ENHANCED_RISK_FACTS = [
    'authorization',
    'migration',
    'concurrency',
    'irreversible_operation',
    'core_state_machine',
];
const STANDARD_RISK_FACTS = [
    'persistent_state',
    'external_side_effect',
    'cross_process_behavior',
    'public_api_change',
];
const ALL_KNOWN_RISK_FACTS = new Set([
    ...ENHANCED_RISK_FACTS,
    ...STANDARD_RISK_FACTS,
    'none',
]);
exports.ALL_KNOWN_RISK_FACTS = ALL_KNOWN_RISK_FACTS;
/** Normalize a raw risk fact entry: `authorization: false` → `authorization`. */
function normalizeRiskFact(fact) {
    return fact
        .trim()
        .replace(/:$/, '')
        .replace(/:.*$/, '')
        .trim()
        .toLowerCase();
}
/**
 * Compute the slice CV minimum level from its declared Risk Facts (canonical
 * mapping): any enhanced fact → 'enhanced'; else any standard fact →
 * 'standard'; else 'lite'. Unknown facts fail closed.
 */
function computeCvMinimumLevel(riskFacts) {
    const normalized = riskFacts.map(normalizeRiskFact);
    for (const rf of normalized) {
        if (rf.length > 0 && !ALL_KNOWN_RISK_FACTS.has(rf)) {
            throw new Error(`Unknown risk fact: "${rf}". Allowed: ${[...ALL_KNOWN_RISK_FACTS].join(', ')}`);
        }
    }
    if (normalized.some((rf) => ENHANCED_RISK_FACTS.includes(rf))) {
        return 'enhanced';
    }
    if (normalized.some((rf) => STANDARD_RISK_FACTS.includes(rf))) {
        return 'standard';
    }
    return 'lite';
}
// ============================================================
// Stage Runtime Proof steps (documented YAML subset, stdlib only)
// ============================================================
/**
 * Parse a `key: value` line. Values may contain colons (split on the first
 * colon only). Returns null when the line carries no key.
 */
function parseKeyValue(line) {
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match)
        return null;
    return { key: match[2], value: match[3], indent: match[1].length };
}
/**
 * Parse a YAML flow array (`[a, b, "c, d"]`) with comma-splitting outside
 * quotes and quote stripping. Elements may contain commas, colons and
 * inner quotes.
 */
function parseFlowArray(raw) {
    const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    if (inner.length === 0)
        return [];
    const elements = [];
    let current = '';
    let quote = null;
    let escaped = false;
    for (const ch of inner) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            current += ch;
            continue;
        }
        if (quote !== null) {
            current += ch;
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ',') {
            elements.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    elements.push(current.trim());
    return elements.map((el) => {
        const trimmed = el.trim();
        if (trimmed.length >= 2 &&
            ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
                (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
            return trimmed.slice(1, -1);
        }
        return trimmed;
    });
}
/**
 * Parse the `## Stage Runtime Proof` section (the documented YAML subset):
 *
 *   steps:
 *     - id: build
 *       type: command
 *       executable: npm
 *       args: [run, build]
 *       cwd: .
 *       timeout_ms: 300000
 *       expected:
 *         exit_code: 0
 *       not_applicable:
 *         reason: ...
 *
 * Returns [] when the section is absent/empty.
 */
function parseRuntimeProofSteps(section) {
    const cleaned = section
        .replace(/^```[a-zA-Z]*\n/gm, '')
        .replace(/```\s*$/gm, '')
        .trim();
    if (cleaned.length === 0)
        return [];
    const steps = [];
    let current = null;
    // Nested map accumulation (expected / not_applicable): stack of open maps.
    const stack = [];
    // Legacy parity: the old compiler filled defaults for steps that omit
    // `cwd` ('.') and `timeout_ms` (300000) — kernel requires both fields.
    const finalizeStep = (step) => {
        const finalized = { ...step };
        if (finalized['cwd'] === undefined)
            finalized['cwd'] = '.';
        if (finalized['timeout_ms'] === undefined)
            finalized['timeout_ms'] = 300000;
        return finalized;
    };
    const closeNested = (indent) => {
        // Infinity flushes every open nested map (a map is an ancestor of a line
        // only when its indent is strictly below the line's indent).
        while (stack.length > 0 &&
            (indent === Infinity || stack[stack.length - 1].indent >= indent)) {
            const opened = stack.pop();
            if (opened && current !== null) {
                current[opened.key] = opened.data;
            }
        }
    };
    for (const line of cleaned.split('\n')) {
        const itemMatch = line.match(/^(\s*)-\s+(\S.*)$/);
        if (itemMatch) {
            // New step item — its first key is `id:`.
            closeNested(Infinity);
            if (current !== null)
                steps.push(finalizeStep(current));
            const kv = parseKeyValue(itemMatch[2]);
            if (!kv) {
                current = null;
                continue;
            }
            current = { [kv.key]: kv.value };
            continue;
        }
        const kv = parseKeyValue(line);
        if (kv === null || current === null)
            continue;
        if (kv.indent === 0) {
            // top-level `steps:` container — ignore
            continue;
        }
        // Close any nested maps that are not ancestors of this line.
        closeNested(kv.indent);
        if (kv.value.length === 0) {
            // nested map opener (expected: / not_applicable:)
            stack.push({ key: kv.key, indent: kv.indent, data: {} });
            continue;
        }
        if (stack.length > 0) {
            // line belongs to the innermost open nested map
            const target = stack[stack.length - 1].data;
            if (kv.key === 'exit_code' || kv.key === 'timeout_ms') {
                target[kv.key] = Number(kv.value);
            }
            else {
                target[kv.key] = kv.value;
            }
            continue;
        }
        // scalar step field
        if (kv.key === 'args') {
            current[kv.key] = parseFlowArray(kv.value);
        }
        else if (kv.key === 'timeout_ms') {
            current[kv.key] = Number(kv.value);
        }
        else {
            current[kv.key] = kv.value;
        }
    }
    closeNested(Infinity);
    if (current !== null)
        steps.push(finalizeStep(current));
    return steps;
}
// ============================================================
// Slice build
// ============================================================
function buildSlice(region, stageId) {
    const publicSeam = extractFirstParagraph(extractSection(region.lines, 'Public Seam'));
    return {
        slice_id: region.sliceId,
        goal: extractFirstParagraph(extractSection(region.lines, 'Goal')) || '(not declared)',
        observable_outcome: extractFirstParagraph(extractSection(region.lines, 'Observable Outcome')) || '(not declared)',
        public_seam: publicSeam || '(not declared)',
        dependencies: parseSliceDependencies(extractSection(region.lines, 'Dependencies')),
        proof_obligations: parseProofObligations(extractSection(region.lines, 'Proof Obligations'), publicSeam),
        tasks: extractTaskIds(extractSection(region.lines, 'Tasks')),
        risk_facts: extractListItems(extractSection(region.lines, 'Risk Facts')),
        evidence_path: `delivery/stages/${stageId}/evidence/${region.sliceId}.md`,
        cv_minimum_level: computeCvMinimumLevel(extractListItems(extractSection(region.lines, 'Risk Facts'))),
    };
}
// ============================================================
// compileManifest
// ============================================================
/**
 * Compile a Stage tasks.md into a canonical Manifest.
 *
 * The result is passed through the kernel `validateManifest` seam before it
 * is returned — a manifest that fails kernel validation is never produced
 * (fail closed).
 */
function compileManifest(tasksPath) {
    let text;
    try {
        text = fs.readFileSync(tasksPath, 'utf-8');
    }
    catch (err) {
        throw new Error(`Tasks file not found: ${tasksPath} (${err instanceof Error ? err.message : String(err)})`);
    }
    const lines = text.split('\n');
    const sourceDigest = crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
    const stageIdMatch = text.match(/^# Stage\s+(S\d[\w-]*)/m);
    const stageId = stageIdMatch?.[1] ?? 'unknown';
    const runtimeProof = parseRuntimeProofSteps(extractSection(lines, 'Stage Runtime Proof'));
    const manifest = {
        stage_id: stageId,
        source_path: tasksPath,
        source_digest: sourceDigest,
        stage_goal: extractFirstParagraph(extractSection(lines, 'Stage Goal')) || '(not declared)',
        outcomes: extractListItems(extractSection(lines, 'Observable Outcomes')),
        slices: extractSliceRegions(text).map((region) => buildSlice(region, stageId)),
        dependencies: extractListItems(extractSection(lines, 'Dependencies')),
        risk_facts: extractListItems(extractSection(lines, 'Stage Risk Facts')),
        runtime_proof: runtimeProof.length > 0 ? runtimeProof : undefined,
        compiled_at: new Date().toISOString(),
        compiled_by: 'compile-manifest.ts',
    };
    // Fail closed: the compiled manifest must pass the kernel validator.
    (0, kernel_1.validateManifest)(manifest);
    return manifest;
}
// ============================================================
// CLI entry
// ============================================================
/**
 * Legacy-compatible CLI:
 *   node dist/cli/compile-manifest.js <tasks-path> <output-manifest-path>
 */
function compileManifestCli(argv) {
    const [tasksPath, outputPath] = argv;
    if (!tasksPath || !outputPath) {
        console.error('Usage: node dist/cli/compile-manifest.js <tasks-path> <output-manifest-path>');
        console.error('');
        console.error('Compiles a Stage tasks.md into a canonical Manifest (kernel');
        console.error('validateManifest must pass) and writes it as JSON.');
        return 1;
    }
    if (!fs.existsSync(tasksPath)) {
        console.error(`Tasks file not found: ${tasksPath}`);
        return 1;
    }
    try {
        const manifest = compileManifest(tasksPath);
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf-8');
        console.log(`Stage manifest written to ${outputPath}`);
        return 0;
    }
    catch (err) {
        console.error(`Compilation failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
}
if (require.main === module) {
    process.exitCode = compileManifestCli(process.argv.slice(2));
}
//# sourceMappingURL=compile-manifest.js.map