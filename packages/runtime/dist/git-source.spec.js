"use strict";
/**
 * gitSource — S02-C-T02 (PO-S02-C-01 data-source part / PO-S02-C-02 source-error part)
 *
 * Verifies the runtime Git source seam against REAL filesystem fixtures:
 * a temporary directory initialized as a REAL git repository (git init +
 * git config + real commits), with real `tasks.md` / evidence files in the
 * canonical layout. No mocks, no cached state files (HP-003).
 *
 * Behaviors under test:
 *   - HEAD is read from `git rev-parse HEAD` (deterministic subprocess).
 *   - per-task checkbox states (`- [x]` / `- [ ]`) are parsed in the
 *     manifest-declared task-ID order, restricted to the slice region
 *     markers (`<!-- SLICE:<id>:BEGIN -->` … `<!-- SLICE:<id>:END -->`)
 *     when present.
 *   - per-task evidence_written (non-placeholder `### <taskId>` subsection
 *     under `## Task Evidence`) and evidence_finalized (the PO-coverage
 *     matrix under `## Current Slice Evidence` is filled / non-placeholder).
 *   - non-git root / git-subdir-as-root → GitSourceError
 *     (RUNTIME.SCHEMA_MISMATCH — Git source unavailable, PO-S02-C-02).
 *   - unborn HEAD (git init without commit) → GitSourceError (fail-closed).
 *   - missing tasks.md → GitSourceError (fail-closed, never guess).
 *   - missing evidence file → evidence_file_present: false with every
 *     evidence fact false (recoverable — reconcile turns the mismatch into
 *     the warn Finding of PO-S02-C-02).
 *   - determinism (HP-003): two reads of the same fixture are deep-equal.
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
const vitest_1 = require("vitest");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const runtime_1 = require("@proofloop/runtime");
// ============================================================
// Real-git fixture helpers
// ============================================================
const cleanups = [];
(0, vitest_1.afterEach)(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn?.();
    }
});
/** Create a temp dir initialized as a REAL git repository. */
function makeGitFixture(stageId = 'S02', sliceId = 'S02-C') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-git-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'git-source@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'Git Source Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const fx = {
        root,
        stageId,
        sliceId,
        head: () => (0, node_child_process_1.execFileSync)('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
        cleanup: () => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            }
            catch {
                // best-effort cleanup
            }
        },
    };
    cleanups.push(fx.cleanup);
    return fx;
}
/** Write a real file below the fixture root (relative path). */
function writeFile(root, rel, content) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
    return p;
}
/** `git add -A` + commit; returns the new HEAD sha. */
function commitAll(fx, message = 'init') {
    (0, node_child_process_1.execFileSync)('git', ['-C', fx.root, 'add', '-A']);
    (0, node_child_process_1.execFileSync)('git', ['-C', fx.root, 'commit', '-q', '-m', message]);
    return fx.head();
}
/** Canonical happy-path tasks.md with slice regions. */
function happyTasksMd(sliceId, checkedTask, uncheckedTask) {
    return [
        `# Stage S02 — Runtime Core`,
        `<!-- SLICE:S02-A:BEGIN -->`,
        `## Slice S02-A — Reducer`,
        `- [x] S02-A-T01: define model`,
        `<!-- SLICE:S02-A:END -->`,
        `<!-- SLICE:${sliceId}:BEGIN -->`,
        `## Slice ${sliceId} — Reconcile`,
        `- [x] ${checkedTask}: first task`,
        `- [ ] ${uncheckedTask}: second task`,
        `<!-- SLICE:${sliceId}:END -->`,
        ``,
    ].join('\n');
}
/** Canonical evidence file: T01 written, PO matrix filled. */
function happyEvidence(sliceId, writtenTask) {
    return [
        `# Slice ${sliceId} Evidence`,
        ``,
        `## Task Evidence`,
        ``,
        `### ${writtenTask}`,
        ``,
        `- Task Goal: layout`,
        `- Status: COMPLETE`,
        ``,
        `## Current Slice Evidence`,
        ``,
        `### Proof Obligation Coverage`,
        ``,
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
        `|---|---|---|---|---|`,
        `| PO-S02-C-05 | contract | r1 | g1 | PASS |`,
        ``,
        `## Current CV Status`,
        ``,
        `- Status: NOT_RUN`,
        ``,
    ].join('\n');
}
function readGitSource(fx, taskIds) {
    return (0, runtime_1.gitSource)({
        projectRoot: fx.root,
        stageId: fx.stageId,
        sliceId: fx.sliceId,
        taskIds,
        evidencePath: `delivery/stages/${fx.stageId}/evidence/${fx.sliceId}.md`,
    });
}
// ============================================================
// Happy path — HEAD, checkboxes, evidence facts (PO-S02-C-01)
// ============================================================
(0, vitest_1.describe)('gitSource — happy path on a real git fixture (PO-S02-C-01)', () => {
    (0, vitest_1.it)('reads HEAD, parses mixed checkboxes in task-ID order, and reads evidence facts', () => {
        const fx = makeGitFixture();
        const taskIds = ['S02-C-T01', 'S02-C-T02'];
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
        writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
        const head = commitAll(fx);
        const result = readGitSource(fx, taskIds);
        (0, vitest_1.expect)(result.head).toBe(head);
        (0, vitest_1.expect)(result.head).toMatch(/^[0-9a-f]{40}$/);
        // Checkbox states in the provided task-ID order, mixed checked/unchecked.
        (0, vitest_1.expect)(result.tasks).toEqual([
            { task_id: 'S02-C-T01', checked: true },
            { task_id: 'S02-C-T02', checked: false },
        ]);
        // Per-task evidence facts.
        (0, vitest_1.expect)(result.evidence).toEqual([
            { task_id: 'S02-C-T01', evidence_written: true },
            { task_id: 'S02-C-T02', evidence_written: false },
        ]);
        (0, vitest_1.expect)(result.evidence_file_present).toBe(true);
        (0, vitest_1.expect)(result.evidence_finalized).toBe(true);
        // Canonical path facts are surfaced.
        (0, vitest_1.expect)(result.tasks_md_path).toBe(path.join(fx.root, 'delivery', 'stages', 'S02', 'tasks.md'));
        (0, vitest_1.expect)(result.evidence_path).toBe(path.join(fx.root, 'delivery', 'stages', 'S02', 'evidence', 'S02-C.md'));
        // gitRoot resolves to the fixture root (path-identical, realpath-safe).
        (0, vitest_1.expect)(result.gitRoot).toBe(fs.realpathSync(fx.root));
    });
    (0, vitest_1.it)('parses checkbox states only from the slice region when region markers are present', () => {
        const fx = makeGitFixture();
        const tasksMd = [
            `# Stage S02`,
            `<!-- SLICE:S02-A:BEGIN -->`,
            `## Slice S02-A`,
            // A decoy checkbox for the TARGET slice's task id living in ANOTHER
            // slice's region — must be ignored when the S02-C region is present.
            `- [x] S02-C-T01: decoy outside the S02-C region`,
            `<!-- SLICE:S02-A:END -->`,
            `<!-- SLICE:S02-C:BEGIN -->`,
            `## Slice S02-C`,
            `- [ ] S02-C-T01: real unchecked line inside the region`,
            `- [x] S02-C-T02: second task`,
            `<!-- SLICE:S02-C:END -->`,
            ``,
        ].join('\n');
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, tasksMd);
        writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
        commitAll(fx);
        const result = readGitSource(fx, ['S02-C-T01', 'S02-C-T02']);
        // Region-scoped parse: the decoy `[x]` outside the region is NOT seen.
        (0, vitest_1.expect)(result.tasks).toEqual([
            { task_id: 'S02-C-T01', checked: false },
            { task_id: 'S02-C-T02', checked: true },
        ]);
    });
    (0, vitest_1.it)('is deterministic: two reads of the same fixture are deep-equal (HP-003)', () => {
        const fx = makeGitFixture();
        const taskIds = ['S02-C-T01', 'S02-C-T02', 'S02-C-T03'];
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
        writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
        commitAll(fx);
        const first = readGitSource(fx, taskIds);
        const second = readGitSource(fx, taskIds);
        (0, vitest_1.expect)(second).toEqual(first);
        (0, vitest_1.expect)(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
});
// ============================================================
// Git source unavailable — structured errors (PO-S02-C-02)
// ============================================================
(0, vitest_1.describe)('gitSource — Git source unavailable (PO-S02-C-02)', () => {
    (0, vitest_1.it)('throws GitSourceError (RUNTIME.SCHEMA_MISMATCH) when projectRoot is not inside a git work tree', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-nongit-'));
        cleanups.push(() => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            }
            catch {
                // best-effort cleanup
            }
        });
        let thrown;
        try {
            (0, runtime_1.gitSource)({
                projectRoot: root,
                stageId: 'S02',
                sliceId: 'S02-C',
                taskIds: ['S02-C-T01'],
                evidencePath: 'delivery/stages/S02/evidence/S02-C.md',
            });
        }
        catch (err) {
            thrown = err;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.GitSourceError);
        const err = thrown;
        (0, vitest_1.expect)(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(err.source).toBe('git');
        (0, vitest_1.expect)(err.message).toMatch(/git work tree|git root/);
    });
    (0, vitest_1.it)('throws GitSourceError when projectRoot is inside a work tree but is NOT the git root', () => {
        const fx = makeGitFixture();
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
        commitAll(fx);
        const subdir = path.join(fx.root, 'delivery');
        (0, vitest_1.expect)(fs.existsSync(subdir)).toBe(true);
        let thrown;
        try {
            (0, runtime_1.gitSource)({
                projectRoot: subdir,
                stageId: 'S02',
                sliceId: 'S02-C',
                taskIds: ['S02-C-T01'],
                evidencePath: 'delivery/stages/S02/evidence/S02-C.md',
            });
        }
        catch (err) {
            thrown = err;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.GitSourceError);
        (0, vitest_1.expect)(thrown.code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(thrown.message).toMatch(/not the git root/);
    });
    (0, vitest_1.it)('throws GitSourceError on an unborn HEAD (git init without any commit)', () => {
        const fx = makeGitFixture();
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
        // No commit — HEAD is unborn.
        let thrown;
        try {
            readGitSource(fx, ['S02-C-T01']);
        }
        catch (err) {
            thrown = err;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.GitSourceError);
        (0, vitest_1.expect)(thrown.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    });
    (0, vitest_1.it)('throws GitSourceError (fail-closed) when tasks.md is missing at the canonical path', () => {
        const fx = makeGitFixture();
        writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
        commitAll(fx);
        let thrown;
        try {
            readGitSource(fx, ['S02-C-T01']);
        }
        catch (err) {
            thrown = err;
        }
        (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.GitSourceError);
        (0, vitest_1.expect)(thrown.code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(thrown.message).toMatch(/tasks\.md/);
        // Never guess: a missing tasks.md must not silently yield "all unchecked".
    });
});
// ============================================================
// Evidence file edge cases
// ============================================================
(0, vitest_1.describe)('gitSource — evidence file facts', () => {
    (0, vitest_1.it)('tolerates a missing evidence file: evidence_file_present false, all evidence facts false', () => {
        const fx = makeGitFixture();
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
        commitAll(fx);
        const result = readGitSource(fx, ['S02-C-T01', 'S02-C-T02']);
        (0, vitest_1.expect)(result.evidence_file_present).toBe(false);
        (0, vitest_1.expect)(result.evidence).toEqual([
            { task_id: 'S02-C-T01', evidence_written: false },
            { task_id: 'S02-C-T02', evidence_written: false },
        ]);
        (0, vitest_1.expect)(result.evidence_finalized).toBe(false);
    });
    (0, vitest_1.it)('reports placeholder task section and placeholder PO matrix as not written / not finalized', () => {
        const fx = makeGitFixture();
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
        writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, [
            `# Slice S02-C Evidence`,
            ``,
            `## Task Evidence`,
            ``,
            `*No tasks have been executed yet.*`,
            ``,
            `## Current Slice Evidence`,
            ``,
            `### Proof Obligation Coverage`,
            ``,
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
            `|---|---|---|---|---|`,
            `| *None* | | | | |`,
            ``,
            `## Current CV Status`,
            ``,
            `- Status: NOT_RUN`,
            ``,
        ].join('\n'));
        commitAll(fx);
        const result = readGitSource(fx, ['S02-C-T01', 'S02-C-T02']);
        (0, vitest_1.expect)(result.evidence_file_present).toBe(true);
        (0, vitest_1.expect)(result.evidence).toEqual([
            { task_id: 'S02-C-T01', evidence_written: false },
            { task_id: 'S02-C-T02', evidence_written: false },
        ]);
        (0, vitest_1.expect)(result.evidence_finalized).toBe(false);
    });
    (0, vitest_1.it)('evidence_finalized is false when the PO matrix has only a header and separator', () => {
        const fx = makeGitFixture();
        writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
        writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, [
            `# Slice S02-C Evidence`,
            ``,
            `## Task Evidence`,
            ``,
            `### S02-C-T01`,
            ``,
            `- Task Goal: layout`,
            ``,
            `## Current Slice Evidence`,
            ``,
            `### Proof Obligation Coverage`,
            ``,
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
            `|---|---|---|---|---|`,
            ``,
        ].join('\n'));
        commitAll(fx);
        const result = readGitSource(fx, ['S02-C-T01']);
        (0, vitest_1.expect)(result.evidence).toEqual([{ task_id: 'S02-C-T01', evidence_written: true }]);
        (0, vitest_1.expect)(result.evidence_finalized).toBe(false);
    });
});
// ============================================================
// Pure parsing helpers (exported seam)
// ============================================================
(0, vitest_1.describe)('parseTaskCheckboxes / parseEvidenceFacts — pure parsers', () => {
    (0, vitest_1.it)('parseTaskCheckboxes returns results in the provided task-ID order and defaults missing ids to unchecked', () => {
        const content = [
            `- [x] S02-C-T01: first`,
            `- [ ] S02-C-T02: second`,
            `- [X] S02-C-T03: uppercase checked`,
            `- [ ] S02-C-T01: duplicate line (last wins, same value)`,
            ``,
        ].join('\n');
        const states = (0, runtime_1.parseTaskCheckboxes)(content, ['S02-C-T03', 'S02-C-T01', 'S02-C-T99']);
        (0, vitest_1.expect)(states).toEqual([
            { task_id: 'S02-C-T03', checked: true },
            { task_id: 'S02-C-T01', checked: false },
            { task_id: 'S02-C-T99', checked: false },
        ]);
    });
    (0, vitest_1.it)('parseTaskCheckboxes falls back to whole-document parsing when slice region markers are absent', () => {
        const content = [
            `## Slice S02-C`,
            `- [x] S02-C-T01: first`,
            `- [ ] S02-C-T02: second`,
            ``,
        ].join('\n');
        (0, vitest_1.expect)((0, runtime_1.parseTaskCheckboxes)(content, ['S02-C-T01', 'S02-C-T02'], 'S02-C')).toEqual([
            { task_id: 'S02-C-T01', checked: true },
            { task_id: 'S02-C-T02', checked: false },
        ]);
    });
    (0, vitest_1.it)('hasTaskEvidenceWritten / isSliceEvidenceFinalized / parseEvidenceFacts', () => {
        const written = happyEvidence('S02-C', 'S02-C-T01');
        (0, vitest_1.expect)((0, runtime_1.hasTaskEvidenceWritten)(written, 'S02-C-T01')).toBe(true);
        (0, vitest_1.expect)((0, runtime_1.hasTaskEvidenceWritten)(written, 'S02-C-T02')).toBe(false);
        (0, vitest_1.expect)((0, runtime_1.isSliceEvidenceFinalized)(written)).toBe(true);
        const placeholder = [
            `## Task Evidence`,
            ``,
            `*No tasks have been executed yet.*`,
            ``,
            `## Current Slice Evidence`,
            ``,
            `### Proof Obligation Coverage`,
            ``,
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
            `|---|---|---|---|---|`,
            `| *None* | | | | |`,
            ``,
        ].join('\n');
        (0, vitest_1.expect)((0, runtime_1.hasTaskEvidenceWritten)(placeholder, 'S02-C-T01')).toBe(false);
        (0, vitest_1.expect)((0, runtime_1.isSliceEvidenceFinalized)(placeholder)).toBe(false);
        const facts = (0, runtime_1.parseEvidenceFacts)(written, ['S02-C-T01', 'S02-C-T02']);
        (0, vitest_1.expect)(facts).toEqual({
            evidence: [
                { task_id: 'S02-C-T01', evidence_written: true },
                { task_id: 'S02-C-T02', evidence_written: false },
            ],
            evidence_finalized: true,
        });
    });
    (0, vitest_1.it)('defaultTasksMdPath resolves the canonical tasks.md location', () => {
        (0, vitest_1.expect)((0, runtime_1.defaultTasksMdPath)('/project', 'S02')).toBe(path.join('/project', 'delivery', 'stages', 'S02', 'tasks.md'));
    });
});
//# sourceMappingURL=git-source.spec.js.map