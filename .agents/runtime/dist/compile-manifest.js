import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseStageFile } from './parse-stage.js';
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
    // Extract global risk facts (from a section if present)
    let riskFacts = [];
    const riskFactsSection = extractSection(lines, 'Risk Facts');
    if (riskFactsSection) {
        riskFacts = extractListItems(riskFactsSection);
    }
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
            const poBlocks = poDefSection.split(/\n\s*-\s*PO-/).slice(1);
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
        // Determine SCV minimum level
        const scvLevelMatch = slice.raw.match(/scv_minimum_level["']?\s*:\s*["'](lite|standard|enhanced)["']/);
        const scvMinimumLevel = (scvLevelMatch?.[1] ?? 'standard');
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
    // Build runtime proof steps (extract from Stage Runtime Proof section if present)
    const runtimeProofSection = extractSection(lines, 'Stage Runtime Proof');
    const runtimeProof = [];
    if (runtimeProofSection) {
        // Extract Build, Startup, Smoke commands
        const buildSection = extractSection(runtimeProofSection.split('\n'), 'Build');
        const smokeSection = extractSection(runtimeProofSection.split('\n'), 'Smoke Scenarios');
        if (buildSection && !buildSection.includes('Not Applicable')) {
            const cmdMatch = buildSection.match(/Command:\s*(.+)/);
            if (cmdMatch) {
                const cmd = cmdMatch[1].trim();
                runtimeProof.push({
                    id: 'build',
                    executable: cmd.split(/\s+/)[0],
                    args: cmd.split(/\s+/).slice(1),
                    cwd: '.',
                    timeout_ms: 300000,
                    expected: { exit_code: 0 },
                });
            }
        }
        if (smokeSection) {
            const lines = smokeSection.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const cmdMatch = lines[i].match(/Command\s*\/\s*Action:\s*(.+)/);
                if (cmdMatch && !cmdMatch[1].includes('Not Applicable')) {
                    const cmd = cmdMatch[1].trim();
                    runtimeProof.push({
                        id: `smoke-${runtimeProof.length + 1}`,
                        executable: cmd.split(/\s+/)[0],
                        args: cmd.split(/\s+/).slice(1),
                        cwd: '.',
                        timeout_ms: 300000,
                        expected: { exit_code: 0 },
                    });
                }
            }
        }
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