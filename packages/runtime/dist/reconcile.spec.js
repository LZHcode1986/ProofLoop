"use strict";
/**
 * reconcileStage — S02-C-T03 (PO-S02-C-02 finding semantics /
 * PO-S02-C-03 chain integrity + fact blocking / PO-S02-C-01 merge determinism)
 *
 * Verifies the three-source merge seam against REAL filesystem fixtures
 * (temp directory + REAL git repo + canonical `.proofloop` layout + kernel
 * ReceiptWriter-produced receipts). No mocks, no cached state files (HP-003).
 *
 * Behaviors under test:
 *   - consistent fixture → NO error findings; per-slice task/cv facts merged.
 *   - determinism: two reconciles of the same fixture are deep-equal.
 *   - every inconsistency kind → canonical Finding (code/severity/message)
 *     with the affected facts left un-guessed (PO-S02-C-02):
 *       receipt referencing unknown slice/stage  → DOMAIN.STAGE_NOT_FOUND
 *       schema-invalid / legacy receipt          → RUNTIME.SCHEMA_MISMATCH
 *       misplaced receipt (type/category)        → RUNTIME.SCHEMA_MISMATCH
 *       manifest missing / stage_id mismatch     → DOMAIN.STAGE_NOT_FOUND
 *       non-git root (git source unavailable)    → RUNTIME.SCHEMA_MISMATCH
 *       git HEAD vs SLICE_COMMIT recorded SHA    → RUNTIME.RECEIPT_CHAIN_BROKEN
 *       task checked ↔ evidence missing          → warn finding (recoverable)
 *   - broken / tampered / duplicate-digest chain → receipt_chain_valid=false
 *     + RUNTIME.RECEIPT_CHAIN_BROKEN + facts blocked (PO-S02-C-03).
 *   - findings deterministically sorted by (code, severity, message).
 *
 * T04 derivation (PO-S02-C-04 / PO-S02-C-01 derivation part) adds the
 * authoritative per-slice/stage facts on real fixtures:
 *   - partial completion → IN_PROGRESS / NOT_STARTED, never committed;
 *   - CV_PASS + finalize-slice receipt (no commit) → CV_PASSED / PASS;
 *   - bound SLICE_COMMIT (no integration) → INTEGRATING / committed;
 *   - bound INTEGRATION_PASS → INTEGRATED / complete, stage COMPLETED;
 *   - CV_REPAIR + later repair-mode TASK_COMPLETE → PENDING_RECHECK;
 *   - binding negatives: unbound SLICE_COMMIT / wrong commit SHA integration
 *     / CV_REPAIR-bound commit → committed/integrated stay false (never
 *     guess; receipt missing or unbound must not mark committed/integrated);
 *   - no receipts at all → cv NOT_STARTED, committed/integrated/complete false;
 *   - contradictory stage facts (STAGE_REVIEW_PASS while a slice is not
 *     integrated) → DOMAIN.INVALID_TRANSITION finding, stage UNINITIALIZED;
 *   - derived facts are deterministic: two reconciles deep-equal.
 *
 * T05 matrix completion (PO → test → assertion completeness):
 *   - determinism WITH findings present — two reconciles of a
 *     multi-inconsistency fixture are deep-equal, findings included, and
 *     every emitted code belongs to the closed 9-code §7 Error Contracts set
 *     (PO-S02-C-01 / PO-S02-C-02);
 *   - a receipt referencing an unknown stage → DOMAIN.STAGE_NOT_FOUND, not
 *     merged (PO-S02-C-02 independent fixture);
 *   - tampered committer chain → receipt_chain_valid false + committed fact
 *     blocked while the cv chain survives (PO-S02-C-03 fact blocking on a
 *     non-cv category);
 *   - `.tmp` scratch receipts and non-json files are never facts and produce
 *     no findings (PO-S02-C-05);
 *   - fully-complete fixture full-chain assertions: receipt_chain (all 7
 *     digests, deterministic order), per-category chains, per-task facts,
 *     cv binding, complete=true (PO-S02-C-04/01).
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
const kernel_1 = require("@proofloop/kernel");
const runtime_1 = require("@proofloop/runtime");
// ============================================================
// Fixture helpers (real temp dir + real git repo + real files)
// ============================================================
const cleanups = [];
(0, vitest_1.afterEach)(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        fn?.();
    }
});
function makeFx(stageId = 'S02') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-reconcile-'));
    (0, node_child_process_1.execFileSync)('git', ['init', '-q', root]);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.email', 'reconcile@test.local']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'user.name', 'Reconcile Test']);
    (0, node_child_process_1.execFileSync)('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
    const fx = {
        root,
        stageId,
        write: (rel, content) => {
            const p = path.join(root, rel);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content, 'utf-8');
        },
        writeManifest: (slices) => {
            const manifest = {
                stage_id: stageId,
                source_path: `delivery/stages/${stageId}/tasks.md`,
                source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
                stage_goal: 'Runtime core application services',
                outcomes: ['deterministic reconcile', 'finding not guessing'],
                slices,
                dependencies: [],
                risk_facts: [],
            };
            fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
        },
        writeTasksMd: (content) => fx.write(`delivery/stages/${stageId}/tasks.md`, content),
        writeEvidence: (sliceId, content) => fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content),
        writeReceipt: (category, sliceId, overrides) => {
            const dir = sliceId !== undefined
                ? (0, runtime_1.receiptCategoryDir)(root, category, stageId, sliceId)
                : (0, runtime_1.receiptCategoryDir)(root, category, stageId);
            fs.mkdirSync(dir, { recursive: true });
            return (0, kernel_1.writeReceipt)({
                version: 1,
                type: 'TASK_COMPLETE',
                stage_id: stageId,
                timestamp: '2025-01-01T00:00:00.000Z',
                payload: {},
                ...overrides,
            }, { receiptDir: dir, tempDir: dir });
        },
        commitAll: (message = 'fixture') => {
            (0, node_child_process_1.execFileSync)('git', ['-C', root, 'add', '-A']);
            (0, node_child_process_1.execFileSync)('git', ['-C', root, 'commit', '-q', '-m', message]);
            return fx.head();
        },
        head: () => (0, node_child_process_1.execFileSync)('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
        reconcile: () => (0, runtime_1.reconcileStage)({ projectRoot: root, stageId }),
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
/** Schema-valid manifest slice (known-good literals, independent of impl). */
function makeSliceDef(sliceId, taskIds) {
    return {
        slice_id: sliceId,
        goal: 'three-source merge',
        observable_outcome: 'deterministic normalized stage state',
        public_seam: '@proofloop/runtime reconcileStage',
        dependencies: ['S02-A'],
        proof_obligations: [
            {
                po_id: 'PO-S02-C-01',
                behavior: 'three-source merge into normalized state',
                public_seam: 'reconcileStage',
                oracle_source: 'real fixture project',
                success_criteria: 'two reconciles deep-equal',
                required_observation: 'fixture oracle',
                applicable_risk_facts: ['persistent_state', 'core_state_machine'],
            },
        ],
        tasks: [...taskIds],
        risk_facts: ['persistent_state'],
        evidence_path: `delivery/stages/${sliceId.slice(0, 3)}/evidence/${sliceId}.md`,
        cv_minimum_level: 'enhanced',
    };
}
/** Canonical tasks.md with slice region markers and per-task checkboxes. */
function makeTasksMd(stageId, slices) {
    const out = [`# Stage ${stageId} — Runtime Core`];
    for (const s of slices) {
        out.push(`<!-- SLICE:${s.sliceId}:BEGIN -->`, `## Slice ${s.sliceId} — Reconcile`);
        for (const t of s.tasks) {
            out.push(`- [${t.checked ? 'x' : ' '}] ${t.id}: task`);
        }
        out.push(`<!-- SLICE:${s.sliceId}:END -->`, ``);
    }
    return out.join('\n');
}
/** Canonical evidence file: given tasks written, PO matrix filled. */
function makeEvidence(sliceId, writtenTasks, finalized = true) {
    const out = [
        `# Slice ${sliceId} Evidence`,
        ``,
        `## Task Evidence`,
        ``,
    ];
    for (const t of writtenTasks) {
        out.push(`### ${t}`, ``, `- Task Goal: merge`, `- Status: COMPLETE`, ``);
    }
    out.push(`## Current Slice Evidence`, ``, `### Proof Obligation Coverage`, ``, `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`, `|---|---|---|---|---|`);
    if (finalized) {
        out.push(`| PO-S02-C-01 | integration | r1 | g1 | PASS |`);
    }
    else {
        out.push(`| *None* | | | | |`);
    }
    out.push(``, `## Current CV Status`, ``, `- Status: NOT_RUN`, ``);
    return out.join('\n');
}
/** All tasks of the default slice written + finalized evidence. */
function defaultEvidence(sliceId = 'S02-C') {
    return makeEvidence(sliceId, ['S02-C-T01', 'S02-C-T02', 'S02-C-T03']);
}
/**
 * Base fixture: real git repo + valid manifest (slice S02-C, 3 tasks) +
 * tasks.md with all tasks checked + evidence fully written/finalized.
 * No receipts. Returns the committed HEAD.
 */
function baseFx(stageId = 'S02') {
    const fx = makeFx(stageId);
    fx.writeManifest([makeSliceDef('S02-C', ['S02-C-T01', 'S02-C-T02', 'S02-C-T03'])]);
    fx.writeTasksMd(makeTasksMd(stageId, [
        {
            sliceId: 'S02-C',
            tasks: [
                { id: 'S02-C-T01', checked: true },
                { id: 'S02-C-T02', checked: true },
                { id: 'S02-C-T03', checked: true },
            ],
        },
    ]));
    fx.writeEvidence('S02-C', defaultEvidence());
    const head = fx.commitAll();
    return { fx, head };
}
/** Fully consistent fixture: base + every category receipt aligned with git. */
function consistentFx(stageId = 'S02') {
    const { fx, head } = baseFx(stageId);
    fx.writeReceipt('plan', undefined, {
        type: 'STAGE_PLAN',
        stage_id: stageId,
        timestamp: '2025-01-01T00:00:00.000Z',
    });
    fx.writeReceipt('cv', 'S02-C', {
        type: 'CV_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-02T00:00:00.000Z',
    });
    fx.writeReceipt('committer', 'S02-C', {
        type: 'SLICE_COMMIT',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-03T00:00:00.000Z',
        payload: { slice_commit_sha: head, status: 'committed' },
    });
    fx.writeReceipt('integration', 'S02-C', {
        type: 'INTEGRATION_PASS',
        stage_id: stageId,
        slice_id: 'S02-C',
        timestamp: '2025-01-04T00:00:00.000Z',
        payload: { status: 'integrated' },
    });
    return { fx, head };
}
function findingsByCode(result) {
    const map = new Map();
    for (const f of result.findings) {
        const bucket = map.get(f.code) ?? [];
        bucket.push(f);
        map.set(f.code, bucket);
    }
    return map;
}
// ============================================================
// Consistent fixture — merge + no error findings (PO-S02-C-01/02)
// ============================================================
(0, vitest_1.describe)('reconcileStage — consistent fixture (PO-S02-C-01/02)', () => {
    (0, vitest_1.it)('merges manifest + git + receipts into a normalized state with no error findings', () => {
        const { fx } = consistentFx();
        const result = fx.reconcile();
        // No findings at all when every source agrees.
        (0, vitest_1.expect)(result.findings).toEqual([]);
        (0, vitest_1.expect)(result.stage_id).toBe('S02');
        // Per-slice task facts merged from the git source.
        (0, vitest_1.expect)(result.slices).toHaveLength(1);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.slice_id).toBe('S02-C');
        (0, vitest_1.expect)(slice.tasks).toEqual([
            { task_id: 'S02-C-T01', checked: true, evidence_written: true },
            { task_id: 'S02-C-T02', checked: true, evidence_written: true },
            { task_id: 'S02-C-T03', checked: true, evidence_written: true },
        ]);
        (0, vitest_1.expect)(slice.slice_evidence_finalized).toBe(true);
        // CV fact merged from the receipt source (only when the chain is valid).
        (0, vitest_1.expect)(slice.latest_cv_receipt?.type).toBe('CV_PASS');
        (0, vitest_1.expect)(slice.latest_cv_receipt?.slice_id).toBe('S02-C');
        // Every scanned category chain is valid.
        (0, vitest_1.expect)(result.receipt_chain_valid).toBe(true);
        for (const c of result.receipt_categories) {
            (0, vitest_1.expect)(c.receipt_chain_valid).toBe(true);
            (0, vitest_1.expect)(c.chain_condition).toBeNull();
        }
        // The flat deterministic receipt digest list contains every receipt.
        (0, vitest_1.expect)(result.receipt_chain.length).toBe(4);
        (0, vitest_1.expect)(new Set(result.receipt_chain).size).toBe(4);
    });
    (0, vitest_1.it)('is deterministic: two reconciles of the same fixture are deep-equal (HP-003)', () => {
        const { fx } = consistentFx();
        const first = fx.reconcile();
        const second = fx.reconcile();
        (0, vitest_1.expect)(second).toEqual(first);
        (0, vitest_1.expect)(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
});
// ============================================================
// DOMAIN.STAGE_NOT_FOUND — unknown slice/stage references (PO-S02-C-02)
// ============================================================
(0, vitest_1.describe)('reconcileStage — DOMAIN.STAGE_NOT_FOUND (PO-S02-C-02)', () => {
    (0, vitest_1.it)('a receipt directory for an unknown slice → DOMAIN.STAGE_NOT_FOUND, no facts guessed for that slice', () => {
        const { fx } = baseFx();
        // Receipts exist for a slice ("S02-Z") that the manifest does not declare.
        fx.writeReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-Z',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const result = fx.reconcile();
        const dom = findingsByCode(result).get('DOMAIN.STAGE_NOT_FOUND') ?? [];
        (0, vitest_1.expect)(dom).toHaveLength(1);
        (0, vitest_1.expect)(dom[0].severity).toBe('error');
        (0, vitest_1.expect)(dom[0].message).toContain('S02-Z');
        // The unknown slice must NOT appear as a normalized slice and no cv fact
        // is invented for it (affected facts stay un-guessed).
        (0, vitest_1.expect)(result.slices.map((s) => s.slice_id)).toEqual(['S02-C']);
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
    });
    (0, vitest_1.it)('a receipt whose slice_id references an unknown slice → DOMAIN.STAGE_NOT_FOUND and is not merged', () => {
        const { fx } = baseFx();
        // A schema-valid CV_PASS whose own slice_id points at an undeclared slice.
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-Z',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const result = fx.reconcile();
        const dom = findingsByCode(result).get('DOMAIN.STAGE_NOT_FOUND') ?? [];
        (0, vitest_1.expect)(dom).toHaveLength(1);
        (0, vitest_1.expect)(dom[0].severity).toBe('error');
        (0, vitest_1.expect)(dom[0].message).toContain('S02-Z');
        // The un-attributable receipt must not produce a cv fact for S02-C.
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
    });
    (0, vitest_1.it)('a receipt referencing an unknown stage → DOMAIN.STAGE_NOT_FOUND and is not merged (T05)', () => {
        const { fx } = baseFx();
        // Schema-valid CV_PASS whose own stage_id disagrees with the reconciled
        // stage (S02) — the receipt source references an unknown stage.
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: 'S99',
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const result = fx.reconcile();
        const dom = findingsByCode(result).get('DOMAIN.STAGE_NOT_FOUND') ?? [];
        (0, vitest_1.expect)(dom).toHaveLength(1);
        (0, vitest_1.expect)(dom[0].severity).toBe('error');
        (0, vitest_1.expect)(dom[0].message).toContain('S99');
        (0, vitest_1.expect)(dom[0].message).toMatch(/unknown stage/);
        // The stage-mismatched receipt must not produce a cv fact for S02-C.
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
    });
    (0, vitest_1.it)('manifest stage_id mismatch → DOMAIN.STAGE_NOT_FOUND (never guessed)', () => {
        const fx = makeFx('S02');
        // Manifest declares a DIFFERENT stage than the reconcile input.
        const manifest = {
            stage_id: 'S99',
            source_path: 'delivery/stages/S99/tasks.md',
            source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
            stage_goal: 'other stage',
            outcomes: ['x'],
            slices: [makeSliceDef('S02-C', ['S02-C-T01'])],
            dependencies: [],
            risk_facts: [],
        };
        fx.write('.proofloop/manifests/S02.json', JSON.stringify(manifest, null, 2));
        fx.writeTasksMd(makeTasksMd('S02', [{ sliceId: 'S02-C', tasks: [{ id: 'S02-C-T01', checked: true }] }]));
        fx.writeEvidence('S02-C', defaultEvidence());
        fx.commitAll();
        const result = fx.reconcile();
        const dom = findingsByCode(result).get('DOMAIN.STAGE_NOT_FOUND') ?? [];
        (0, vitest_1.expect)(dom).toHaveLength(1);
        (0, vitest_1.expect)(dom[0].severity).toBe('error');
        (0, vitest_1.expect)(dom[0].message).toMatch(/manifest source unavailable/);
        // Without a valid manifest no slice structure is invented.
        (0, vitest_1.expect)(result.slices).toEqual([]);
        (0, vitest_1.expect)(result.findings.every((f) => f.code === 'DOMAIN.STAGE_NOT_FOUND')).toBe(true);
    });
    (0, vitest_1.it)('missing manifest → DOMAIN.STAGE_NOT_FOUND, empty un-guessed state', () => {
        const fx = makeFx('S02');
        // No manifest file at all. (Nothing to commit — HEAD would be unborn, but
        // the manifest failure dominates: reconcile must not even attempt git.)
        const result = fx.reconcile();
        const dom = findingsByCode(result).get('DOMAIN.STAGE_NOT_FOUND') ?? [];
        (0, vitest_1.expect)(dom).toHaveLength(1);
        (0, vitest_1.expect)(dom[0].severity).toBe('error');
        (0, vitest_1.expect)(dom[0].message).toMatch(/manifest source unavailable/);
        (0, vitest_1.expect)(result.slices).toEqual([]);
        (0, vitest_1.expect)(result.receipt_chain).toEqual([]);
    });
});
// ============================================================
// RUNTIME.SCHEMA_MISMATCH — schema/legacy/misplaced receipts (PO-S02-C-02)
// ============================================================
(0, vitest_1.describe)('reconcileStage — RUNTIME.SCHEMA_MISMATCH (PO-S02-C-02)', () => {
    (0, vitest_1.it)('a schema-invalid receipt file → RUNTIME.SCHEMA_MISMATCH and is never a fact', () => {
        const { fx } = baseFx();
        const cvDir = (0, runtime_1.receiptCategoryDir)(fx.root, 'cv', fx.stageId, 'S02-C');
        fs.mkdirSync(cvDir, { recursive: true });
        fs.writeFileSync(path.join(cvDir, 'bad.json'), '{ not valid json', 'utf-8');
        const result = fx.reconcile();
        const schema = findingsByCode(result).get('RUNTIME.SCHEMA_MISMATCH') ?? [];
        (0, vitest_1.expect)(schema.some((f) => f.severity === 'error' && f.message.includes('bad.json'))).toBe(true);
        // The invalid file cannot produce a cv fact.
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
    });
    (0, vitest_1.it)('a legacy receipt (version 2) → RUNTIME.SCHEMA_MISMATCH', () => {
        const { fx } = baseFx();
        const cvDir = (0, runtime_1.receiptCategoryDir)(fx.root, 'cv', fx.stageId, 'S02-C');
        fs.mkdirSync(cvDir, { recursive: true });
        // Handcrafted legacy receipt: schema-valid JSON but version !== 1.
        fs.writeFileSync(path.join(cvDir, 'legacy.json'), JSON.stringify({
            version: 2,
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: {},
            digest: 'not-a-computed-digest',
        }), 'utf-8');
        const result = fx.reconcile();
        const schema = findingsByCode(result).get('RUNTIME.SCHEMA_MISMATCH') ?? [];
        (0, vitest_1.expect)(schema.some((f) => f.severity === 'error' && f.message.includes('legacy.json'))).toBe(true);
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
    });
    (0, vitest_1.it)('a misplaced receipt (type/category mismatch) → RUNTIME.SCHEMA_MISMATCH and is not used as a fact', () => {
        const { fx, head } = baseFx();
        fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: { slice_commit_sha: head, status: 'committed' },
        });
        // A schema-valid CV_PASS misplaced into the committer directory.
        const misplaced = fx.writeReceipt('committer', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const result = fx.reconcile();
        const schema = findingsByCode(result).get('RUNTIME.SCHEMA_MISMATCH') ?? [];
        (0, vitest_1.expect)(schema.some((f) => f.severity === 'error' &&
            f.message.includes('misplaced receipt') &&
            f.message.includes('CV_PASS') &&
            f.message.includes('committer'))).toBe(true);
        // The misplaced receipt digest must not enter the receipt chain facts.
        (0, vitest_1.expect)(result.receipt_chain.includes(misplaced.digest)).toBe(false);
    });
    (0, vitest_1.it)('a slice-bound receipt that disagrees with its directory → RUNTIME.SCHEMA_MISMATCH and is not merged', () => {
        const fx = makeFx('S02');
        // Two known slices; the receipt is slice-bound to S02-A but lives in S02-C's cv dir.
        fx.writeManifest([
            makeSliceDef('S02-A', []),
            makeSliceDef('S02-C', ['S02-C-T01', 'S02-C-T02', 'S02-C-T03']),
        ]);
        fx.writeTasksMd(makeTasksMd('S02', [
            { sliceId: 'S02-A', tasks: [] },
            {
                sliceId: 'S02-C',
                tasks: [
                    { id: 'S02-C-T01', checked: true },
                    { id: 'S02-C-T02', checked: true },
                    { id: 'S02-C-T03', checked: true },
                ],
            },
        ]));
        fx.writeEvidence('S02-A', makeEvidence('S02-A', []));
        fx.writeEvidence('S02-C', defaultEvidence());
        fx.commitAll();
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: 'S02',
            slice_id: 'S02-A', // known, but not the directory slice
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const result = fx.reconcile();
        const schema = findingsByCode(result).get('RUNTIME.SCHEMA_MISMATCH') ?? [];
        (0, vitest_1.expect)(schema.some((f) => f.severity === 'error' && f.message.includes('slice-bound'))).toBe(true);
        // The ambiguous receipt must not be attributed to either slice.
        (0, vitest_1.expect)(result.slices.find((s) => s.slice_id === 'S02-C')?.latest_cv_receipt).toBeNull();
        (0, vitest_1.expect)(result.slices.find((s) => s.slice_id === 'S02-A')?.latest_cv_receipt).toBeNull();
    });
});
// ============================================================
// RUNTIME.RECEIPT_CHAIN_BROKEN — git/commit mismatch + chain integrity
// (PO-S02-C-02 / PO-S02-C-03)
// ============================================================
(0, vitest_1.describe)('reconcileStage — RUNTIME.RECEIPT_CHAIN_BROKEN (PO-S02-C-02/03)', () => {
    (0, vitest_1.it)('git HEAD without the SLICE_COMMIT recorded SHA → RUNTIME.RECEIPT_CHAIN_BROKEN', () => {
        const { fx } = baseFx();
        // The commit receipt records a SHA that is not in the git history of HEAD.
        fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: { slice_commit_sha: 'a'.repeat(40), status: 'committed' },
        });
        const result = fx.reconcile();
        const broken = findingsByCode(result).get('RUNTIME.RECEIPT_CHAIN_BROKEN') ?? [];
        (0, vitest_1.expect)(broken).toHaveLength(1);
        (0, vitest_1.expect)(broken[0].severity).toBe('error');
        (0, vitest_1.expect)(broken[0].message).toMatch(/SLICE_COMMIT receipt/);
        (0, vitest_1.expect)(broken[0].message).toMatch(/git HEAD/);
        // The commit fact stays un-guessed (committed remains false — T04 derives).
        (0, vitest_1.expect)(result.slices[0].committed).toBe(false);
    });
    (0, vitest_1.it)('tampered chained receipt → receipt_chain_valid false + finding + cv facts blocked (PO-S02-C-03)', () => {
        const { fx } = baseFx();
        const r1 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        const r2 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: r1.digest,
        });
        // Tamper with r2's content WITHOUT recomputing its digest.
        const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8'));
        raw.payload = { tampered: true };
        fs.writeFileSync(r2.path, JSON.stringify(raw));
        const result = fx.reconcile();
        const broken = findingsByCode(result).get('RUNTIME.RECEIPT_CHAIN_BROKEN') ?? [];
        // The chain-level finding mentions the category directory.
        (0, vitest_1.expect)(broken.some((f) => f.message.includes('receipt chain broken in cv'))).toBe(true);
        (0, vitest_1.expect)(broken.every((f) => f.severity === 'error')).toBe(true);
        // Overall + per-category chain validity flips false.
        (0, vitest_1.expect)(result.receipt_chain_valid).toBe(false);
        const cvState = result.receipt_categories.find((c) => c.category === 'cv' && c.slice_id === 'S02-C');
        (0, vitest_1.expect)(cvState?.receipt_chain_valid).toBe(false);
        (0, vitest_1.expect)(cvState?.chain_condition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
        // Fact blocking: no cv fact may be derived from a broken chain.
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
    });
    (0, vitest_1.it)('duplicate digest → receipt_chain_valid false + finding + facts blocked (PO-S02-C-03)', () => {
        const { fx } = baseFx();
        const r1 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        // Same content under a second filename → duplicate digest.
        const cvDir = (0, runtime_1.receiptCategoryDir)(fx.root, 'cv', fx.stageId, 'S02-C');
        fs.copyFileSync(r1.path, path.join(cvDir, 'duplicate.json'));
        const result = fx.reconcile();
        const broken = findingsByCode(result).get('RUNTIME.RECEIPT_CHAIN_BROKEN') ?? [];
        (0, vitest_1.expect)(broken.some((f) => f.message.includes('receipt chain broken in cv'))).toBe(true);
        (0, vitest_1.expect)(result.receipt_chain_valid).toBe(false);
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
    });
    (0, vitest_1.it)('tampered committer chain → chain broken + committed fact blocked, cv chain unaffected (PO-S02-C-03, T05)', () => {
        const { fx, head } = baseFx();
        const cvPass = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const c1 = fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: {
                status: 'committed',
                slice_commit_sha: head,
                cv_receipt_digest: cvPass.digest,
            },
        });
        const c2 = fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-04T00:00:00.000Z',
            payload: { status: 'committed', slice_commit_sha: head },
            previous_digest: c1.digest,
        });
        // Tamper with the newest committer receipt WITHOUT recomputing its digest.
        const raw = JSON.parse(fs.readFileSync(c2.path, 'utf-8'));
        raw.payload = { tampered: true };
        fs.writeFileSync(c2.path, JSON.stringify(raw));
        const result = fx.reconcile();
        const broken = findingsByCode(result).get('RUNTIME.RECEIPT_CHAIN_BROKEN') ?? [];
        (0, vitest_1.expect)(broken.some((f) => f.message.includes('receipt chain broken in committer'))).toBe(true);
        (0, vitest_1.expect)(broken.every((f) => f.severity === 'error')).toBe(true);
        // Overall + per-category chain validity flips false for committer only.
        (0, vitest_1.expect)(result.receipt_chain_valid).toBe(false);
        const committerState = result.receipt_categories.find((c) => c.category === 'committer' && c.slice_id === 'S02-C');
        (0, vitest_1.expect)(committerState?.receipt_chain_valid).toBe(false);
        (0, vitest_1.expect)(committerState?.chain_condition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
        // Fact blocking: no committed fact may be derived from the broken
        // committer chain (PO-S02-C-03 "不推进该分类事实").
        (0, vitest_1.expect)(result.slices[0].committed).toBe(false);
        (0, vitest_1.expect)(result.slices[0].integrated).toBe(false);
        (0, vitest_1.expect)(result.slices[0].complete).toBe(false);
        // The cv chain is a different category directory — its facts survive.
        const cvState = result.receipt_categories.find((c) => c.category === 'cv' && c.slice_id === 'S02-C');
        (0, vitest_1.expect)(cvState?.receipt_chain_valid).toBe(true);
        (0, vitest_1.expect)(result.slices[0].cv_status).toBe(kernel_1.CVStatus.PASS);
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt?.digest).toBe(cvPass.digest);
    });
});
// ============================================================
// RUNTIME.SCHEMA_MISMATCH — git source unavailable (PO-S02-C-02)
// ============================================================
(0, vitest_1.describe)('reconcileStage — git source unavailable (PO-S02-C-02)', () => {
    (0, vitest_1.it)('non-git root → RUNTIME.SCHEMA_MISMATCH (git source unavailable)', () => {
        // A temp directory that is NOT a git work tree, with a valid manifest.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-nongit-reconcile-'));
        cleanups.push(() => {
            try {
                fs.rmSync(root, { recursive: true, force: true });
            }
            catch {
                // best-effort cleanup
            }
        });
        const manifest = {
            stage_id: 'S02',
            source_path: 'delivery/stages/S02/tasks.md',
            source_digest: 'd',
            stage_goal: 'g',
            outcomes: ['o'],
            slices: [makeSliceDef('S02-C', ['S02-C-T01'])],
            dependencies: [],
            risk_facts: [],
        };
        fs.mkdirSync(path.join(root, '.proofloop', 'manifests'), { recursive: true });
        fs.writeFileSync(path.join(root, '.proofloop', 'manifests', 'S02.json'), JSON.stringify(manifest), 'utf-8');
        const result = (0, runtime_1.reconcileStage)({ projectRoot: root, stageId: 'S02' });
        const schema = findingsByCode(result).get('RUNTIME.SCHEMA_MISMATCH') ?? [];
        (0, vitest_1.expect)(schema.some((f) => f.severity === 'error' && f.message.includes('git source unavailable'))).toBe(true);
        // No git facts are fabricated: every task stays at the un-guessed default
        // and the error finding blocks downstream use (never a silent guess).
        (0, vitest_1.expect)(result.slices[0].tasks).toEqual([{ task_id: 'S02-C-T01', checked: false, evidence_written: false }]);
    });
});
// ============================================================
// Warn findings — task checked ↔ evidence (PO-S02-C-02, recoverable)
// ============================================================
(0, vitest_1.describe)('reconcileStage — recoverable warn findings (PO-S02-C-02)', () => {
    (0, vitest_1.it)('task checked while its evidence section is missing → warn finding', () => {
        const fx = makeFx('S02');
        fx.writeManifest([makeSliceDef('S02-C', ['S02-C-T01', 'S02-C-T02'])]);
        fx.writeTasksMd(makeTasksMd('S02', [
            {
                sliceId: 'S02-C',
                tasks: [
                    { id: 'S02-C-T01', checked: true },
                    { id: 'S02-C-T02', checked: false },
                ],
            },
        ]));
        // Evidence file missing entirely (all evidence facts false).
        fx.commitAll();
        const result = fx.reconcile();
        const warns = result.findings.filter((f) => f.severity === 'warn');
        (0, vitest_1.expect)(warns).toHaveLength(1);
        (0, vitest_1.expect)(warns[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(warns[0].message).toContain('S02-C-T01');
        (0, vitest_1.expect)(warns[0].message).toMatch(/evidence section is missing/);
    });
    (0, vitest_1.it)('task evidence written but not checked → warn finding', () => {
        const fx = makeFx('S02');
        fx.writeManifest([makeSliceDef('S02-C', ['S02-C-T01', 'S02-C-T02'])]);
        fx.writeTasksMd(makeTasksMd('S02', [
            {
                sliceId: 'S02-C',
                tasks: [
                    { id: 'S02-C-T01', checked: false },
                    { id: 'S02-C-T02', checked: false },
                ],
            },
        ]));
        fx.writeEvidence('S02-C', makeEvidence('S02-C', ['S02-C-T01']));
        fx.commitAll();
        const result = fx.reconcile();
        const warns = result.findings.filter((f) => f.severity === 'warn');
        (0, vitest_1.expect)(warns).toHaveLength(1);
        (0, vitest_1.expect)(warns[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(warns[0].message).toContain('S02-C-T01');
        (0, vitest_1.expect)(warns[0].message).toMatch(/evidence written but is not checked/);
    });
});
// ============================================================
// RUNTIME.SCHEMA_MISMATCH — .tmp / non-json exclusion at reconcile level
// (PO-S02-C-05: 不允许把 `.tmp`/非 json 当 receipt)
// ============================================================
(0, vitest_1.describe)('reconcileStage — .tmp / non-json never become receipts (PO-S02-C-05)', () => {
    (0, vitest_1.it)('receipts left in the .tmp scratch dir and non-json files are never facts, no findings (T05)', () => {
        const { fx } = baseFx();
        // A schema-valid CV_PASS left in the `.tmp` scratch directory — the
        // reconcile must never scan it (scratch is not a receipt source).
        const tmpDir = (0, runtime_1.tmpReceiptDir)(fx.root);
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpWrite = (0, kernel_1.writeReceipt)({
            version: 1,
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: {},
        }, { receiptDir: tmpDir, tempDir: tmpDir });
        // Non-json files and kernel-temp-style files inside a category dir.
        const cvDir = (0, runtime_1.receiptCategoryDir)(fx.root, 'cv', fx.stageId, 'S02-C');
        fs.mkdirSync(cvDir, { recursive: true });
        fs.writeFileSync(path.join(cvDir, 'readme.txt'), 'not a receipt');
        fs.writeFileSync(path.join(cvDir, 'scratch.json.tmp'), '{"version":1}');
        const result = fx.reconcile();
        // None of these files is a receipt: no findings, no facts, no chain entry.
        (0, vitest_1.expect)(result.findings).toEqual([]);
        (0, vitest_1.expect)(result.receipt_chain_valid).toBe(true);
        (0, vitest_1.expect)(result.receipt_chain).toEqual([]);
        (0, vitest_1.expect)(result.receipt_chain.includes(tmpWrite.digest)).toBe(false);
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt).toBeNull();
        (0, vitest_1.expect)(result.slices[0].cv_status).toBe(kernel_1.CVStatus.NOT_STARTED);
    });
});
// ============================================================
// Determinism WITH findings present + closed §7 finding-code set
// (PO-S02-C-01 / PO-S02-C-02 — 多次归并 deep-equal 含 Findings)
// ============================================================
(0, vitest_1.describe)('reconcileStage — determinism with findings + closed code set (PO-S02-C-01/02)', () => {
    (0, vitest_1.it)('two reconciles of a multi-inconsistency fixture are deep-equal, findings included; every code is in the closed §7 set (T05)', () => {
        // Kitchen-sink fixture with four inconsistency kinds at once:
        //   - unknown slice directory        → DOMAIN.STAGE_NOT_FOUND
        //   - invalid JSON receipt           → RUNTIME.SCHEMA_MISMATCH (error)
        //   - tampered cv chain              → RUNTIME.RECEIPT_CHAIN_BROKEN
        //   - checked task without evidence  → RUNTIME.SCHEMA_MISMATCH (warn)
        const fx = makeFx('S02');
        fx.writeManifest([makeSliceDef('S02-C', ['S02-C-T01', 'S02-C-T02'])]);
        fx.writeTasksMd(makeTasksMd('S02', [
            {
                sliceId: 'S02-C',
                tasks: [
                    { id: 'S02-C-T01', checked: true },
                    { id: 'S02-C-T02', checked: false },
                ],
            },
        ]));
        // No evidence file at all → T01 checked without evidence → warn finding.
        fx.writeReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            stage_id: 'S02',
            slice_id: 'S02-Z',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        // Write the valid chained receipts FIRST (the kernel writer verifies the
        // directory chain before writing — an invalid file would block the write).
        const r1 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: 'S02',
            slice_id: 'S02-C',
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        const r2 = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: 'S02',
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: r1.digest,
        });
        // THEN drop the invalid JSON and tamper with r2's content.
        const cvDir = (0, runtime_1.receiptCategoryDir)(fx.root, 'cv', fx.stageId, 'S02-C');
        fs.mkdirSync(cvDir, { recursive: true });
        fs.writeFileSync(path.join(cvDir, 'bad.json'), '{ nope', 'utf-8');
        const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8'));
        raw.payload = { tampered: true };
        fs.writeFileSync(r2.path, JSON.stringify(raw));
        fx.commitAll();
        const first = fx.reconcile();
        const second = fx.reconcile();
        // HP-003: the same input produces the identical output, findings included.
        (0, vitest_1.expect)(second).toEqual(first);
        (0, vitest_1.expect)(JSON.stringify(second)).toBe(JSON.stringify(first));
        (0, vitest_1.expect)(first.findings.length).toBeGreaterThan(0);
        // Every emitted finding code is one of the closed 9-code §7 Error
        // Contracts set (never an unlisted code — PO-S02-C-02).
        const CLOSED_FINDING_CODES = new Set([
            'HOST.PROJECT_NOT_TRUSTED',
            'HOST.PATH_PROTECTED',
            'HOST.TOOL_NOT_ACTIVE',
            'HOST.PATH_OUTSIDE_PROJECT',
            'RUNTIME.VERSION_MISMATCH',
            'RUNTIME.RECEIPT_CHAIN_BROKEN',
            'RUNTIME.SCHEMA_MISMATCH',
            'DOMAIN.STAGE_NOT_FOUND',
            'DOMAIN.INVALID_TRANSITION',
        ]);
        for (const f of first.findings) {
            (0, vitest_1.expect)(CLOSED_FINDING_CODES.has(f.code)).toBe(true);
        }
        // All four kinds present, deterministically sorted.
        const codes = first.findings.map((f) => f.code);
        (0, vitest_1.expect)(codes).toContain('DOMAIN.STAGE_NOT_FOUND');
        (0, vitest_1.expect)(codes).toContain('RUNTIME.RECEIPT_CHAIN_BROKEN');
        (0, vitest_1.expect)(first.findings.some((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH' && f.severity === 'error')).toBe(true);
        (0, vitest_1.expect)(first.findings.some((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH' && f.severity === 'warn')).toBe(true);
        (0, vitest_1.expect)(first.receipt_chain_valid).toBe(false);
    });
});
// ============================================================
// Findings — deterministic ordering (PO-S02-C-02)
// ============================================================
(0, vitest_1.describe)('reconcileStage — findings deterministic order (PO-S02-C-02)', () => {
    (0, vitest_1.it)('sorts findings by (code, severity, message)', () => {
        const { fx } = baseFx();
        // Produce several different finding kinds in one fixture:
        //  - unknown slice directory → DOMAIN.STAGE_NOT_FOUND
        //  - invalid JSON receipt   → RUNTIME.SCHEMA_MISMATCH (error)
        //  - checked task without evidence → RUNTIME.SCHEMA_MISMATCH (warn)
        fx.writeReceipt('cv', 'S02-Z', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-Z',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const cvDir = (0, runtime_1.receiptCategoryDir)(fx.root, 'cv', fx.stageId, 'S02-C');
        fs.mkdirSync(cvDir, { recursive: true });
        fs.writeFileSync(path.join(cvDir, 'bad.json'), '{ nope', 'utf-8');
        const result = fx.reconcile();
        // A fixture with a checked-but-evidence-missing warn.
        const fx2 = makeFx('S02');
        fx2.writeManifest([makeSliceDef('S02-C', ['S02-C-T01'])]);
        fx2.writeTasksMd(makeTasksMd('S02', [{ sliceId: 'S02-C', tasks: [{ id: 'S02-C-T01', checked: true }] }]));
        fx2.commitAll();
        const result2 = fx2.reconcile();
        const combined = [...result.findings, ...result2.findings];
        const sorted = (0, runtime_1.sortFindings)(combined);
        // sortFindings returns a sorted, deduplicated array.
        for (let i = 1; i < sorted.length; i++) {
            (0, vitest_1.expect)((0, runtime_1.compareFindings)(sorted[i - 1], sorted[i])).toBeLessThanOrEqual(0);
        }
        (0, vitest_1.expect)(sorted).toEqual((0, runtime_1.sortFindings)(sorted));
        // The reconcile output itself is sorted the same way.
        for (let i = 1; i < result.findings.length; i++) {
            (0, vitest_1.expect)((0, runtime_1.compareFindings)(result.findings[i - 1], result.findings[i])).toBeLessThanOrEqual(0);
        }
        // DOMAIN.STAGE_NOT_FOUND sorts before RUNTIME.* and the warn severity
        // sorts after the error severity within the same code.
        const codes = sorted.map((f) => f.code);
        (0, vitest_1.expect)(codes.indexOf('DOMAIN.STAGE_NOT_FOUND')).toBeLessThan(codes.indexOf('RUNTIME.SCHEMA_MISMATCH'));
        const schemaWarn = sorted.find((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH' && f.severity === 'warn');
        const schemaError = sorted.find((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH' && f.severity === 'error');
        (0, vitest_1.expect)(schemaWarn && schemaError && sorted.indexOf(schemaError)).toBeLessThan(schemaWarn && schemaError ? sorted.indexOf(schemaWarn) : -1);
    });
});
// ============================================================
// Multi-slice merge (PO-S02-C-01)
// ============================================================
(0, vitest_1.describe)('reconcileStage — multi-slice merge (PO-S02-C-01)', () => {
    (0, vitest_1.it)('attributes per-slice cv facts to the correct slice', () => {
        const fx = makeFx('S02');
        fx.writeManifest([
            makeSliceDef('S02-A', ['S02-A-T01']),
            makeSliceDef('S02-C', ['S02-C-T01']),
        ]);
        fx.writeTasksMd(makeTasksMd('S02', [
            { sliceId: 'S02-A', tasks: [{ id: 'S02-A-T01', checked: true }] },
            { sliceId: 'S02-C', tasks: [{ id: 'S02-C-T01', checked: true }] },
        ]));
        fx.writeEvidence('S02-A', makeEvidence('S02-A', ['S02-A-T01']));
        fx.writeEvidence('S02-C', makeEvidence('S02-C', ['S02-C-T01']));
        fx.commitAll();
        fx.writeReceipt('cv', 'S02-A', {
            type: 'CV_PASS',
            stage_id: 'S02',
            slice_id: 'S02-A',
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_REPAIR',
            stage_id: 'S02',
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        (0, vitest_1.expect)(result.slices.map((s) => s.slice_id)).toEqual(['S02-A', 'S02-C']);
        (0, vitest_1.expect)(result.slices[0].latest_cv_receipt?.type).toBe('CV_PASS');
        (0, vitest_1.expect)(result.slices[1].latest_cv_receipt?.type).toBe('CV_REPAIR');
    });
});
// ============================================================
// PO-S02-C-04 / PO-S02-C-01 — per-slice/stage authoritative derivation
// (S02-C-T04: receipts-authoritative cv/committed/integrated/complete,
//  slice_state mapping, deriveStageState wiring)
// ============================================================
(0, vitest_1.describe)('reconcileStage — per-slice/stage authoritative derivation (PO-S02-C-04 / PO-S02-C-01)', () => {
    /** Fully-completed slice: finalize + CV PASS + bound commit + bound integration + stage review. */
    function completedFx(stageId = 'S02') {
        const { fx, head } = baseFx(stageId);
        const cvPass = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const digests = {
            finalize: fx.writeReceipt('tasks', 'S02-C', {
                type: 'TASK_COMPLETE',
                stage_id: stageId,
                slice_id: 'S02-C',
                timestamp: '2025-01-01T00:00:00.000Z',
                payload: { mode: 'finalize-slice' },
            }),
            stagePlan: fx.writeReceipt('plan', undefined, {
                type: 'STAGE_PLAN',
                stage_id: stageId,
                timestamp: '2025-01-01T00:00:00.000Z',
            }),
            spvPass: fx.writeReceipt('plan', undefined, {
                type: 'SPV_PASS',
                stage_id: stageId,
                timestamp: '2025-01-02T00:00:00.000Z',
            }),
            cvPass,
            commit: fx.writeReceipt('committer', 'S02-C', {
                type: 'SLICE_COMMIT',
                stage_id: stageId,
                slice_id: 'S02-C',
                timestamp: '2025-01-03T00:00:00.000Z',
                payload: {
                    status: 'committed',
                    slice_commit_sha: head,
                    cv_receipt_digest: cvPass.digest,
                },
            }),
            integration: fx.writeReceipt('integration', 'S02-C', {
                type: 'INTEGRATION_PASS',
                stage_id: stageId,
                slice_id: 'S02-C',
                timestamp: '2025-01-04T00:00:00.000Z',
                payload: { status: 'integrated', slice_commit_sha: head },
            }),
            review: fx.writeReceipt('review', undefined, {
                type: 'STAGE_REVIEW_PASS',
                stage_id: stageId,
                timestamp: '2025-01-05T00:00:00.000Z',
            }),
        };
        return { fx, head, digests };
    }
    (0, vitest_1.it)('部分完成: partial tasks + unfinalized evidence + no receipts → IN_PROGRESS / NOT_STARTED, never committed', () => {
        const fx = makeFx('S02');
        fx.writeManifest([makeSliceDef('S02-C', ['S02-C-T01', 'S02-C-T02', 'S02-C-T03'])]);
        fx.writeTasksMd(makeTasksMd('S02', [
            {
                sliceId: 'S02-C',
                tasks: [
                    { id: 'S02-C-T01', checked: true },
                    { id: 'S02-C-T02', checked: false },
                    { id: 'S02-C-T03', checked: false },
                ],
            },
        ]));
        fx.writeEvidence('S02-C', makeEvidence('S02-C', ['S02-C-T01'], false));
        fx.commitAll();
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.IN_PROGRESS);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.NOT_STARTED);
        (0, vitest_1.expect)(slice.slice_evidence_finalized).toBe(false);
        (0, vitest_1.expect)(slice.committed).toBe(false);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
        (0, vitest_1.expect)(slice.latest_cv_receipt).toBeNull();
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.UNINITIALIZED);
    });
    (0, vitest_1.it)('全部勾选 + finalized + finalize-slice TASK_COMPLETE (no CV yet) → slice READY_FOR_CV, cv NOT_STARTED', () => {
        const { fx } = baseFx();
        fx.writeReceipt('tasks', 'S02-C', {
            type: 'TASK_COMPLETE',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { mode: 'finalize-slice' },
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.NOT_STARTED);
        (0, vitest_1.expect)(slice.committed).toBe(false);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
    });
    (0, vitest_1.it)('CV 通过未提交: CV_PASS + finalize receipt, no commit receipt → CV_PASSED / PASS, not committed', () => {
        const { fx } = baseFx();
        fx.writeReceipt('tasks', 'S02-C', {
            type: 'TASK_COMPLETE',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { mode: 'finalize-slice' },
        });
        fx.writeReceipt('plan', undefined, {
            type: 'STAGE_PLAN',
            stage_id: fx.stageId,
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        fx.writeReceipt('plan', undefined, {
            type: 'SPV_PASS',
            stage_id: fx.stageId,
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.CV_PASSED);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.PASS);
        (0, vitest_1.expect)(slice.latest_cv_receipt?.type).toBe('CV_PASS');
        (0, vitest_1.expect)(slice.committed).toBe(false);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.EXECUTING);
    });
    (0, vitest_1.it)('已提交未集成: bound SLICE_COMMIT, no integration receipt → INTEGRATING / committed, not integrated', () => {
        const { fx, head } = baseFx();
        const cvPass = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: { status: 'committed', slice_commit_sha: head, cv_receipt_digest: cvPass.digest },
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.committed).toBe(true);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.INTEGRATING);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.PASS);
    });
    (0, vitest_1.it)('全部完成: bound commit + bound integration + stage review → INTEGRATED / complete, stage COMPLETED', () => {
        const { fx } = completedFx();
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.INTEGRATED);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.PASS);
        (0, vitest_1.expect)(slice.committed).toBe(true);
        (0, vitest_1.expect)(slice.integrated).toBe(true);
        (0, vitest_1.expect)(slice.complete).toBe(true);
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.COMPLETED);
        (0, vitest_1.expect)(result.receipt_chain_valid).toBe(true);
    });
    (0, vitest_1.it)('完整完成全链路: complete=true 贯通 receipt 链 / per-category 链 / per-task 事实 / cv 绑定 (T05)', () => {
        const { fx, head, digests } = completedFx();
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        // Derived completion facts (PO-S02-C-04 five-condition complete).
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.INTEGRATED);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.PASS);
        (0, vitest_1.expect)(slice.slice_evidence_finalized).toBe(true);
        (0, vitest_1.expect)(slice.committed).toBe(true);
        (0, vitest_1.expect)(slice.integrated).toBe(true);
        (0, vitest_1.expect)(slice.complete).toBe(true);
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.COMPLETED);
        // Per-task facts: every declared task checked with evidence written.
        (0, vitest_1.expect)(slice.tasks).toEqual([
            { task_id: 'S02-C-T01', checked: true, evidence_written: true },
            { task_id: 'S02-C-T02', checked: true, evidence_written: true },
            { task_id: 'S02-C-T03', checked: true, evidence_written: true },
        ]);
        // The cv fact is the exact bound CV_PASS receipt.
        (0, vitest_1.expect)(slice.latest_cv_receipt?.type).toBe('CV_PASS');
        (0, vitest_1.expect)(slice.latest_cv_receipt?.slice_id).toBe('S02-C');
        (0, vitest_1.expect)(slice.latest_cv_receipt?.digest).toBe(digests.cvPass.digest);
        // Every per-category chain is valid: 4 slice-level + 4 stage-level states.
        (0, vitest_1.expect)(result.receipt_categories).toHaveLength(8);
        for (const c of result.receipt_categories) {
            (0, vitest_1.expect)(c.receipt_chain_valid).toBe(true);
            (0, vitest_1.expect)(c.chain_condition).toBeNull();
        }
        // Full deterministic receipt chain: all 7 receipts, unique digests, in
        // (timestamp, digest) order (literal comparator over known fixture data —
        // an independent oracle, not the implementation's own comparator).
        const pairs = [
            { t: '2025-01-01T00:00:00.000Z', d: digests.finalize.digest },
            { t: '2025-01-01T00:00:00.000Z', d: digests.stagePlan.digest },
            { t: '2025-01-02T00:00:00.000Z', d: digests.spvPass.digest },
            { t: '2025-01-02T00:00:00.000Z', d: digests.cvPass.digest },
            { t: '2025-01-03T00:00:00.000Z', d: digests.commit.digest },
            { t: '2025-01-04T00:00:00.000Z', d: digests.integration.digest },
            { t: '2025-01-05T00:00:00.000Z', d: digests.review.digest },
        ].sort((a, b) => (a.t !== b.t ? (a.t < b.t ? -1 : 1) : a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
        (0, vitest_1.expect)(result.receipt_chain).toEqual(pairs.map((p) => p.d));
        (0, vitest_1.expect)(new Set(result.receipt_chain).size).toBe(7);
        // The committed fact is bound to the real committed git HEAD.
        (0, vitest_1.expect)(result.slices[0].committed).toBe(true);
        (0, vitest_1.expect)(head.length).toBe(40);
    });
    (0, vitest_1.it)('repair 复查: repair-mode TASK_COMPLETE after the last CV_REPAIR → PENDING_RECHECK, slice READY_FOR_CV', () => {
        const { fx } = baseFx();
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_REPAIR',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
        });
        fx.writeReceipt('tasks', 'S02-C', {
            type: 'TASK_COMPLETE',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-04T00:00:00.000Z',
            payload: { mode: 'repair' },
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.PENDING_RECHECK);
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
        (0, vitest_1.expect)(slice.latest_cv_receipt?.type).toBe('CV_REPAIR');
        (0, vitest_1.expect)(slice.repair_attempt).toBe(0);
        (0, vitest_1.expect)(slice.committed).toBe(false);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
    });
    (0, vitest_1.it)('CV_REPAIR without a later repair TASK_COMPLETE → REPAIR, slice back to READY_FOR_CV', () => {
        const { fx } = baseFx();
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_REPAIR',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.REPAIR);
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.READY_FOR_CV);
    });
    (0, vitest_1.it)('repair TASK_COMPLETE BEFORE the last CV_REPAIR → REPAIR, never PENDING_RECHECK', () => {
        const { fx } = baseFx();
        fx.writeReceipt('tasks', 'S02-C', {
            type: 'TASK_COMPLETE',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { mode: 'repair' },
        });
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_REPAIR',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.slices[0].cv_status).toBe(kernel_1.CVStatus.REPAIR);
    });
    (0, vitest_1.it)('repair-mode TASK_COMPLETE without any CV_REPAIR (latest is CV_PASS) → PASS, never PENDING_RECHECK', () => {
        const { fx } = baseFx();
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        fx.writeReceipt('tasks', 'S02-C', {
            type: 'TASK_COMPLETE',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-04T00:00:00.000Z',
            payload: { mode: 'repair' },
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.slices[0].cv_status).toBe(kernel_1.CVStatus.PASS);
    });
    (0, vitest_1.it)('SLICE_COMMIT without a cv_receipt_digest binding → committed stays false (never guess)', () => {
        const { fx, head } = baseFx();
        fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: { status: 'committed', slice_commit_sha: head },
        });
        const result = fx.reconcile();
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.committed).toBe(false);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.PASS);
    });
    (0, vitest_1.it)('SLICE_COMMIT bound to a CV_REPAIR digest → committed stays false (CV must be PASS)', () => {
        const { fx, head } = baseFx();
        const cvRepair = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_REPAIR',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: { status: 'committed', slice_commit_sha: head, cv_receipt_digest: cvRepair.digest },
        });
        const result = fx.reconcile();
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.committed).toBe(false);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.REPAIR);
    });
    (0, vitest_1.it)('INTEGRATION_PASS bound to a different commit SHA → integrated stays false', () => {
        const { fx, head } = baseFx();
        const cvPass = fx.writeReceipt('cv', 'S02-C', {
            type: 'CV_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        fx.writeReceipt('committer', 'S02-C', {
            type: 'SLICE_COMMIT',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-03T00:00:00.000Z',
            payload: { status: 'committed', slice_commit_sha: head, cv_receipt_digest: cvPass.digest },
        });
        fx.writeReceipt('integration', 'S02-C', {
            type: 'INTEGRATION_PASS',
            stage_id: fx.stageId,
            slice_id: 'S02-C',
            timestamp: '2025-01-04T00:00:00.000Z',
            payload: { status: 'integrated', slice_commit_sha: 'b'.repeat(40) },
        });
        const result = fx.reconcile();
        const slice = result.slices[0];
        (0, vitest_1.expect)(slice.committed).toBe(true);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.INTEGRATING);
    });
    (0, vitest_1.it)('no receipts at all → cv NOT_STARTED, committed/integrated/complete all false (禁止 receipt 缺失仍标记)', () => {
        const { fx } = baseFx();
        const result = fx.reconcile();
        const slice = result.slices[0];
        // All tasks checked + evidence finalized, but NO finalize-slice
        // TASK_COMPLETE receipt → not READY_FOR_CV (receipts are authoritative).
        (0, vitest_1.expect)(slice.slice_state).toBe(kernel_1.SliceState.IN_PROGRESS);
        (0, vitest_1.expect)(slice.cv_status).toBe(kernel_1.CVStatus.NOT_STARTED);
        (0, vitest_1.expect)(slice.latest_cv_receipt).toBeNull();
        (0, vitest_1.expect)(slice.committed).toBe(false);
        (0, vitest_1.expect)(slice.integrated).toBe(false);
        (0, vitest_1.expect)(slice.complete).toBe(false);
    });
    (0, vitest_1.it)('STAGE_REVIEW_PASS while a slice is not integrated → DOMAIN.INVALID_TRANSITION finding, stage UNINITIALIZED', () => {
        const { fx } = baseFx();
        fx.writeReceipt('plan', undefined, {
            type: 'STAGE_PLAN',
            stage_id: fx.stageId,
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        fx.writeReceipt('plan', undefined, {
            type: 'SPV_PASS',
            stage_id: fx.stageId,
            timestamp: '2025-01-02T00:00:00.000Z',
        });
        fx.writeReceipt('review', undefined, {
            type: 'STAGE_REVIEW_PASS',
            stage_id: fx.stageId,
            timestamp: '2025-01-03T00:00:00.000Z',
        });
        const result = fx.reconcile();
        const invalid = result.findings.filter((f) => f.code === 'DOMAIN.INVALID_TRANSITION');
        (0, vitest_1.expect)(invalid).toHaveLength(1);
        (0, vitest_1.expect)(invalid[0].severity).toBe('error');
        (0, vitest_1.expect)(invalid[0].message).toMatch(/STAGE_REVIEW_PASS/);
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.UNINITIALIZED);
    });
    (0, vitest_1.it)('derived facts are deterministic: two reconciles of the fully-complete fixture are deep-equal (PO-S02-C-01)', () => {
        const { fx } = completedFx();
        const first = fx.reconcile();
        const second = fx.reconcile();
        (0, vitest_1.expect)(second).toEqual(first);
        (0, vitest_1.expect)(JSON.stringify(second)).toBe(JSON.stringify(first));
        (0, vitest_1.expect)(first.slices[0].complete).toBe(true);
        (0, vitest_1.expect)(first.slices[0].integrated).toBe(true);
        (0, vitest_1.expect)(first.stage_state).toBe(kernel_1.StageState.COMPLETED);
    });
    // ── F-1: deterministic project_state derivation (HP-003 — receipts are
    //        the only source; no hardcoded IN_PROGRESS) ──
    (0, vitest_1.it)('project_state: no stage-boundary facts → IN_PROGRESS (safe default, never a guess)', () => {
        const fx = makeFx('S02');
        fx.writeManifest([makeSliceDef('S02-C', ['S02-C-T01'])]);
        fx.writeTasksMd(makeTasksMd('S02', [{ sliceId: 'S02-C', tasks: [{ id: 'S02-C-T01', checked: true }] }]));
        fx.writeEvidence('S02-C', makeEvidence('S02-C', ['S02-C-T01'], true));
        fx.commitAll();
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.UNINITIALIZED);
        (0, vitest_1.expect)(result.project_state).toBe('IN_PROGRESS');
    });
    (0, vitest_1.it)('project_state: stage COMPLETED without a PROJECT_REVIEW_PASS receipt → UNDER_REVIEW (next gate after stage review)', () => {
        const { fx } = completedFx();
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.COMPLETED);
        (0, vitest_1.expect)(result.project_state).toBe('UNDER_REVIEW');
    });
    (0, vitest_1.it)('project_state: a PROJECT_REVIEW_PASS receipt in the shared project/ chain → COMPLETED', () => {
        const { fx } = completedFx();
        fx.writeReceipt('project', undefined, {
            type: 'PROJECT_REVIEW_PASS',
            stage_id: fx.stageId,
            timestamp: '2025-01-06T00:00:00.000Z',
        });
        const result = fx.reconcile();
        (0, vitest_1.expect)(result.findings).toEqual([]);
        (0, vitest_1.expect)(result.stage_state).toBe(kernel_1.StageState.COMPLETED);
        (0, vitest_1.expect)(result.project_state).toBe('COMPLETED');
    });
});
//# sourceMappingURL=reconcile.spec.js.map