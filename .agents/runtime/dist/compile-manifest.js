import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import YAML from 'yaml';
import { parseStageFile } from './parse-stage.js';
import { computeScvLevel } from './compute-scv-level.js';
import { RuntimeProofStep } from './schemas.js';
/**
 * Extract the content of a Markdown section by heading (## or ###).
 */
function extractSection(lines, heading) {
    const startIdx = lines.findIndex(l => {
        const trimmed = l.trim();
        const match = trimmed.match(/^#{2,3}\s+(.+)/);
        return match !== null && match[1].trim() === heading;
    });
    if (startIdx === -1)
        return '';
    const rest = lines.slice(startIdx + 1);
    const endIdx = rest.findIndex(l => /^#{1,3}\s/.test(l.trim()));
    return endIdx === -1 ? rest.join('\n').trim() : rest.slice(0, endIdx).join('\n').trim();
}
/**
 * Extract Stage-level Risk Facts from a `## Stage Risk Facts` heading.
 * Uses exact heading match (`^## Stage Risk Facts$`) to avoid matching
 * Slice-level `### Risk Facts` (three hashes).
 */
function extractStageRiskFacts(lines) {
    const idx = lines.findIndex(l => l.trim() === '## Stage Risk Facts');
    if (idx === -1)
        return [];
    const rest = lines.slice(idx + 1);
    const endIdx = rest.findIndex(l => /^##\s/.test(l.trim()));
    const section = endIdx === -1 ? rest.join('\n').trim() : rest.slice(0, endIdx).join('\n').trim();
    return extractListItems(section);
}
/**
 * Extract list items (- item) from text.
 */
function extractListItems(text) {
    return text.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))
        .map(l => l.slice(2).trim())
        .filter(Boolean);
}
/**
 * Extract the first paragraph of a section (content before any sub-heading).
 */
function extractFirstParagraph(text) {
    return text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'))
        .join(' ')
        .trim();
}
/**
 * Extract all task IDs from a Tasks section.
 */
function extractTaskIds(text) {
    return text.split('\n')
        .map(l => l.trim())
        .filter(l => /^- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/.test(l))
        .map(l => {
        const match = l.match(/- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/);
        return match ? match[1] : '';
    })
        .filter(Boolean);
}
export function compileManifest(tasksPath) {
    const text = fs.readFileSync(tasksPath, 'utf-8');
    const lines = text.split('\n');
    // Compute SHA-256 digest of the source file
    const sourceDigest = crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
    // Extract stage ID
    const stageIdMatch = text.match(/^# Stage\s+(S\d[\w-]*)/m);
    const stageId = stageIdMatch?.[1] ?? 'unknown';
    // Extract stage goal
    const stageGoalText = extractSection(lines, 'Stage Goal');
    // Take the first non-empty line as the goal
    const stageGoal = extractFirstParagraph(stageGoalText);
    // Extract observable outcomes
    const outcomesText = extractSection(lines, 'Observable Outcomes');
    const outcomes = extractListItems(outcomesText);
    // Extract global dependencies
    const depsText = extractSection(lines, 'Dependencies');
    const dependencies = extractListItems(depsText);
    // Extract global risk facts from `## Stage Risk Facts` (stage-level only, not slice-level `### Risk Facts`)
    const riskFacts = extractStageRiskFacts(lines);
    // Parse slices
    const parsed = parseStageFile(tasksPath);
    // Build slices for manifest
    const slices = parsed.slices.map(slice => {
        // Extract fields from the slice content
        const goal = extractFirstParagraph(extractSection(slice.lines, 'Goal'));
        const observableOutcome = extractFirstParagraph(extractSection(slice.lines, 'Observable Outcome'));
        const publicSeam = extractFirstParagraph(extractSection(slice.lines, 'Public Seam'));
        // Extract dependencies
        const sliceDepsText = extractSection(slice.lines, 'Dependencies');
        const sliceDeps = extractListItems(sliceDepsText)
            .map(item => item.split(/\s+/)[0])
            .filter(id => /^S\d{2,}-[A-Z]$/.test(id));
        // Extract risk facts
        const sliceRiskFactsText = extractSection(slice.lines, 'Risk Facts');
        const sliceRiskFacts = extractListItems(sliceRiskFactsText);
        // Extract tasks
        const tasksText = extractSection(slice.lines, 'Tasks');
        const tasks = extractTaskIds(tasksText);
        // Extract proof obligations from the Proof Obligations section
        const proofObligations = [];
        const poDefSection = extractSection(slice.lines, 'Proof Obligations');
        if (poDefSection) {
            // Split by PO entries: each PO block starts with "- PO-"
            // NOTE: Must prepend \n so the first PO is not discarded (split delimiter requires preceding \n)
            const poBlocks = (`\n${poDefSection}`).split(/\n\s*-\s*PO-/).slice(1);
            for (const rawBlock of poBlocks) {
                const fullBlock = 'PO-' + rawBlock;
                const poIdMatch = fullBlock.match(/^(PO-S\d{2,}-[A-Z]-\d{2})/);
                if (!poIdMatch)
                    continue;
                const poId = poIdMatch[1];
                // Extract fields from indented sub-list under the PO
                // Format:
                //   - Behavior:
                //   - Public Seam:
                //   - Oracle Source:
                //   - Success / Failure:
                //   - Required Observation:
                //   - Applicable Risk Facts:
                const fieldLines = fullBlock.split('\n')
                    .map(l => l.trim())
                    .filter(l => l.startsWith('- '));
                const fields = new Map();
                for (const line of fieldLines) {
                    const match = line.match(/^-\s+(.+?):\s*(.*)$/);
                    if (match) {
                        const key = match[1].trim().toLowerCase().replace(/[^a-z0-9_\/]+/g, '_');
                        const value = match[2].trim();
                        fields.set(key, value);
                    }
                }
                proofObligations.push({
                    po_id: poId,
                    behavior: fields.get('behavior') || 'verified',
                    public_seam: fields.get('public_seam') || publicSeam,
                    oracle_source: fields.get('oracle_source') || '',
                    success_criteria: fields.get('success_/_failure') || fields.get('success_failure') || '',
                    failure_criteria: undefined,
                    required_observation: fields.get('required_observation') || undefined,
                    applicable_risk_facts: fields.has('applicable_risk_facts') && fields.get('applicable_risk_facts')
                        ? fields.get('applicable_risk_facts').split(',').map(s => s.trim()).filter(Boolean)
                        : undefined,
                });
            }
        }
        // Determine SCV minimum level from Risk Facts (not from manual scv_minimum_level field)
        const scvMinimumLevel = computeScvLevel(sliceRiskFacts);
        return {
            slice_id: slice.sliceId,
            goal,
            observable_outcome: observableOutcome,
            public_seam: publicSeam,
            dependencies: sliceDeps,
            proof_obligations: proofObligations,
            tasks,
            risk_facts: sliceRiskFacts,
            scv_minimum_level: scvMinimumLevel,
        };
    });
    // ── Helper: parse YAML steps using the yaml library ──
    // Expected format:
    //   steps:
    //     - id: build
    //       executable: npm
    //       args: [run, build]
    //       cwd: .
    //       timeout_ms: 300000
    //       expected:
    //         exit_code: 0
    function parseYamlSteps(yamlText) {
        // Strip fenced code block markers (```yaml, ```) if present
        const cleaned = yamlText
            .replace(/^```[a-zA-Z]*\n/gm, '')
            .replace(/```\s*$/gm, '')
            .trim();
        if (!cleaned)
            return [];
        const parsed = YAML.parse(cleaned);
        if (!parsed || !Array.isArray(parsed.steps))
            return [];
        return z.array(RuntimeProofStep).parse(parsed.steps);
    }
    // Build runtime proof steps (extract from Stage Runtime Proof section if present)
    const runtimeProofSection = extractSection(lines, 'Stage Runtime Proof');
    const runtimeProof = [];
    if (runtimeProofSection) {
        const parsed = parseYamlSteps(runtimeProofSection);
        runtimeProof.push(...parsed);
    }
    const manifest = {
        stage_id: stageId,
        source_path: tasksPath,
        source_digest: sourceDigest,
        stage_goal: stageGoal,
        outcomes,
        slices,
        dependencies,
        risk_facts: riskFacts,
        runtime_proof: runtimeProof,
        compiled_at: new Date().toISOString(),
        compiled_by: 'compile-manifest.ts',
    };
    return manifest;
}
//# sourceMappingURL=compile-manifest.js.map