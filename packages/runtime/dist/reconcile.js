"use strict";
/**
 * @proofloop/runtime — ReconcileService: three-source merge (S02-C-T03)
 *
 * Merges the three authoritative sources of a stage reconcile into one
 * deterministic normalized state snapshot (HP-003 — never a guess):
 *
 *   1. Manifest source (S02-C-T02): stage/slice structure + task/evidence
 *      paths, validated through the kernel `validateManifest` seam. Missing /
 *      parse-failed / schema-invalid / stage_id-mismatched manifest →
 *      `DOMAIN.STAGE_NOT_FOUND` (PO-S02-C-02).
 *   2. Git source (S02-C-T02): HEAD, tasks.md checkbox states and evidence
 *      file facts from the real work tree. A non-git root / unborn HEAD /
 *      missing tasks.md makes the Git source unavailable →
 *      `RUNTIME.SCHEMA_MISMATCH` (PO-S02-C-02).
 *   3. Receipts source (S02-C-T01): the canonical category directory layout,
 *      read through the receipt reader — kernel `verifyReceiptChain` per
 *      category directory (PO-S02-C-03), schema validation, type/category
 *      misplacement detection and deterministic (timestamp, digest) ordering.
 *
 * Inconsistency → Finding mapping (Authority Excerpts, PO-S02-C-02):
 *   - receipt references unknown slice/stage        → DOMAIN.STAGE_NOT_FOUND
 *   - schema-invalid / legacy receipt               → RUNTIME.SCHEMA_MISMATCH
 *   - misplaced receipt (type/category mismatch)    → RUNTIME.SCHEMA_MISMATCH
 *   - slice-bound receipt disagreeing with its
 *     directory                                     → RUNTIME.SCHEMA_MISMATCH
 *   - manifest missing / stage_id mismatch          → DOMAIN.STAGE_NOT_FOUND
 *   - non-git root (git source unavailable)         → RUNTIME.SCHEMA_MISMATCH
 *   - git HEAD does not contain the SHA recorded in
 *     a SLICE_COMMIT receipt                        → RUNTIME.RECEIPT_CHAIN_BROKEN
 *   - broken / tampered / duplicate-digest chain    → RUNTIME.RECEIPT_CHAIN_BROKEN
 *   - task checked while evidence missing (or vice
 *     versa)                                        → RUNTIME.SCHEMA_MISMATCH
 *                                                    (severity 'warn' — recoverable;
 *                                                     the only warn finding of the
 *                                                     closed 9-code set, picked for
 *                                                     the work-tree fact mismatch)
 *
 * Affected facts stay un-guessed (HP-003):
 *   - receipts referencing unknown slices/stages are never merged — the
 *     unknown entity simply does not exist in the normalized output;
 *   - a receipt whose own slice_id disagrees with its containing directory
 *     is attributed to neither slice (ambiguous → no guess);
 *   - when a category chain is invalid, NO fact is derived from that chain —
 *     the category is marked `receipt_chain_valid: false` (PO-S02-C-03 fact
 *     blocking) and the overall `receipt_chain_valid` is false;
 *   - when the Git source is unavailable the per-task facts stay at the
 *     un-guessed default and the error Finding blocks downstream use.
 *
 * Per-slice/stage authoritative derivation (cv_status / slice_state /
 * committed / integrated / complete / stage_state) is the S02-C-T04 concern,
 * implemented below against the PO-S02-C-04 mapping (receipts authoritative;
 * missing/unbound receipts never mark committed/integrated/complete; stage
 * derivation through S02-A `deriveStageState` with READY folding; a
 * contradictory stage fact combination surfaces a `DOMAIN.INVALID_TRANSITION`
 * finding instead of a silent guess).
 *
 * Determinism (HP-003): every scan order is fixed (manifest declaration
 * order, canonical category order, sorted directory listings) and findings are
 * sorted by (code, severity, message) with exact-duplicate collapse.
 * Read-only — never writes, repairs or commits.
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
exports.compareFindings = compareFindings;
exports.sortFindings = sortFindings;
exports.reconcileStage = reconcileStage;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const kernel_1 = require("@proofloop/kernel");
const manifest_source_1 = require("./manifest-source");
const git_source_1 = require("./git-source");
const receipt_reader_1 = require("./receipt-reader");
const receipt_layout_1 = require("./receipt-layout");
const stage_state_1 = require("./stage-state");
// ============================================================
// Category sets
// ============================================================
/** Slice-level categories — one directory per slice, chain per directory. */
const SLICE_LEVEL_CATEGORIES = [
    'tasks',
    'cv',
    'committer',
    'integration',
];
/** Stage-level categories — one directory per stage, read once. */
const STAGE_LEVEL_CATEGORIES = [
    'plan',
    'stage-gate',
    'review',
    'project',
];
// ============================================================
// Finding ordering — deterministic (code, severity, message)
// ============================================================
/**
 * Deterministic comparator over canonical Findings: code ascending, then
 * severity ascending ('error' < 'warn'), then message ascending — plain
 * locale-independent string comparison (HP-003).
 */
function compareFindings(a, b) {
    if (a.code !== b.code)
        return a.code < b.code ? -1 : 1;
    if (a.severity !== b.severity)
        return a.severity < b.severity ? -1 : 1;
    if (a.message !== b.message)
        return a.message < b.message ? -1 : 1;
    return 0;
}
/**
 * Deterministic finding ordering: sort by (code, severity, message) and
 * collapse exact duplicates. Identical (code, severity, message) findings
 * carry the same information, so the collapse is order-stable and lossless.
 */
function sortFindings(findings) {
    const sorted = [...findings].sort(compareFindings);
    const out = [];
    for (const f of sorted) {
        const last = out[out.length - 1];
        if (last === undefined ||
            last.code !== f.code ||
            last.severity !== f.severity ||
            last.message !== f.message) {
            out.push(f);
        }
    }
    return out;
}
// ============================================================
// Internal helpers
// ============================================================
/** Path relative to the project root — host-independent finding messages. */
function relPath(projectRoot, absolutePath) {
    const rel = path.relative(projectRoot, absolutePath);
    return rel.length === 0 ? '.' : rel;
}
/**
 * Attribute a valid category-correct receipt to the reconciled stage.
 *
 * Rules (never a guess, HP-003):
 *   - `stage_id` not matching the reconciled stage → DOMAIN.STAGE_NOT_FOUND,
 *     the receipt is not merged;
 *   - `slice_id` referencing a slice the manifest does not declare →
 *     DOMAIN.STAGE_NOT_FOUND, the receipt is not merged;
 *   - `slice_id` present and different from the containing directory slice →
 *     RUNTIME.SCHEMA_MISMATCH (a slice-bound receipt disagreeing with its
 *     directory — ambiguous attribution), the receipt is not merged.
 *
 * @returns true when the receipt may be merged as a fact.
 */
function attributeReceipt(read, ctx) {
    const { receipt } = read;
    const label = relPath(ctx.projectRoot, read.filePath);
    if (receipt.stage_id !== ctx.stageId) {
        ctx.findings.push({
            code: 'DOMAIN.STAGE_NOT_FOUND',
            severity: 'error',
            message: `receipt ${label} references unknown stage "${receipt.stage_id}"`,
        });
        return false;
    }
    if (receipt.slice_id !== undefined && !ctx.knownSlices.has(receipt.slice_id)) {
        ctx.findings.push({
            code: 'DOMAIN.STAGE_NOT_FOUND',
            severity: 'error',
            message: `receipt ${label} references unknown slice "${receipt.slice_id}"`,
        });
        return false;
    }
    if (ctx.directorySlice !== null &&
        receipt.slice_id !== undefined &&
        receipt.slice_id !== ctx.directorySlice) {
        ctx.findings.push({
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message: `receipt ${label} is slice-bound to "${receipt.slice_id}" but lives in ` +
                `the "${ctx.directorySlice}" ${ctx.category} directory`,
        });
        return false;
    }
    return true;
}
/**
 * Check a SLICE_COMMIT receipt's recorded commit against the Git source
 * (PO-S02-C-02): the recorded `slice_commit_sha` must exist in the current
 * git history (be an ancestor of HEAD, equality included). A recorded SHA
 * that is not an ancestor of HEAD → RUNTIME.RECEIPT_CHAIN_BROKEN — the Git
 * source and the receipt chain disagree, no commit fact may be trusted.
 */
function checkCommitReceiptHead(read, gitHead, ctx) {
    const sha = read.receipt.payload?.['slice_commit_sha'];
    if (typeof sha !== 'string' || sha.length === 0) {
        // No recorded SHA — nothing to compare (committer-boundary binding is
        // the S02-C-T04 domain, not a T03 inconsistency kind).
        return;
    }
    if (gitHead === null) {
        // Git source unavailable — the git-unavailable Finding already covers it.
        return;
    }
    if (!isCommitAncestorOfHead(ctx.projectRoot, sha, gitHead)) {
        ctx.findings.push({
            code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
            severity: 'error',
            message: `SLICE_COMMIT receipt ${relPath(ctx.projectRoot, read.filePath)} records commit ` +
                `${sha} which is not an ancestor of git HEAD ${gitHead}`,
        });
    }
}
/** `git merge-base --is-ancestor <sha> <head>` — exit 0 ⇒ true. */
function isCommitAncestorOfHead(projectRoot, sha, head) {
    try {
        (0, node_child_process_1.execFileSync)('git', ['merge-base', '--is-ancestor', sha, head], {
            cwd: projectRoot,
            stdio: 'ignore',
        });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Directories under slice-level category stage dirs that the manifest does
 * not declare → receipts exist for an unknown slice (PO-S02-C-02).
 */
function findUnknownSliceDirs(projectRoot, stageId, knownSlices) {
    const out = [];
    for (const category of SLICE_LEVEL_CATEGORIES) {
        const stageDir = path.join((0, receipt_layout_1.receiptsRoot)(projectRoot), category, stageId);
        let entries;
        try {
            entries = fs.readdirSync(stageDir, { withFileTypes: true });
        }
        catch {
            continue; // no receipts of this category at all
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !knownSlices.has(entry.name)) {
                out.push(path.join(stageDir, entry.name));
            }
        }
    }
    return out.sort();
}
/**
 * Process one category directory read: chain-validity marker + findings
 * (chain / invalid files / misplacements) + fact merge when the chain is
 * valid (attribution + commit-SHA check).
 */
function handleCategoryRead(sliceId, category, result, ctx, merge, gitHead) {
    merge.categoryStates.push({
        category,
        slice_id: sliceId,
        receipt_chain_valid: result.chainValid,
        chain_condition: result.chainCondition,
    });
    if (!result.chainValid) {
        ctx.findings.push({
            code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
            severity: 'error',
            message: `receipt chain broken in ${category}` +
                (sliceId !== null ? ` (slice "${sliceId}")` : '') +
                `: ${result.chainCondition?.reason ?? 'chain verification failed'}`,
        });
    }
    for (const file of result.invalidFiles) {
        ctx.findings.push({
            code: file.code,
            severity: 'error',
            message: `invalid receipt ${relPath(ctx.projectRoot, file.filePath)}: ${file.reason}`,
        });
    }
    for (const m of result.misplaced) {
        ctx.findings.push({
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message: `misplaced receipt ${relPath(ctx.projectRoot, m.filePath)}: type ${m.receiptType} ` +
                `found in ${m.foundInCategory} directory (expected ${m.expectedCategory})`,
        });
    }
    // PO-S02-C-03 fact blocking: NO fact may be derived from a broken chain.
    if (!result.chainValid)
        return;
    const attrCtx = {
        ...ctx,
        category,
        directorySlice: sliceId,
    };
    for (const read of result.receipts) {
        if (!attributeReceipt(read, attrCtx))
            continue;
        merge.validReads.push(read);
        if (category === 'committer' && read.receipt.type === 'SLICE_COMMIT') {
            checkCommitReceiptHead(read, gitHead, attrCtx);
        }
    }
}
/** Deterministic empty state when the manifest source is unavailable. */
function emptyResult(stageId, findings) {
    return {
        stage_id: stageId,
        slices: [],
        stage_state: kernel_1.StageState.UNINITIALIZED,
        project_state: kernel_1.ProjectState.IN_PROGRESS,
        receipt_chain: [],
        findings: sortFindings(findings),
        receipt_chain_valid: true,
        receipt_categories: [],
    };
}
/** Newest receipt of a scan per the deterministic (timestamp, digest) order. */
function latestOfType(reads) {
    let latest = null;
    for (const read of reads) {
        if (latest === null || (0, receipt_reader_1.compareReceiptsByTimestampDigest)(latest, read) < 0) {
            latest = read;
        }
    }
    return latest;
}
/**
 * Build the per-slice receipt facts of one slice from the attributed,
 * chain-valid receipt merge (PO-S02-C-03 fact blocking: receipts of a broken
 * chain never reach `validReads`, so no fact is derived from them).
 */
function buildSliceReceiptFacts(validReads, sliceId) {
    const cvReads = [];
    const commitReads = [];
    const integrationReads = [];
    const taskReads = [];
    let cvRepairCount = 0;
    for (const read of validReads) {
        if (read.receipt.slice_id !== sliceId)
            continue;
        switch (read.receipt.type) {
            case 'CV_PASS':
                cvReads.push(read);
                break;
            case 'CV_REPAIR':
                cvReads.push(read);
                cvRepairCount += 1;
                break;
            case 'SLICE_COMMIT':
                commitReads.push(read);
                break;
            case 'INTEGRATION_PASS':
                integrationReads.push(read);
                break;
            case 'TASK_COMPLETE':
                taskReads.push(read);
                break;
            default:
                break;
        }
    }
    const repairTaskCompletes = taskReads.filter((r) => {
        const mode = r.receipt.payload?.['mode'];
        return mode === 'repair' || mode === 'diagnose';
    });
    return {
        latestCv: latestOfType(cvReads),
        latestSliceCommit: latestOfType(commitReads),
        latestIntegrationPass: latestOfType(integrationReads),
        latestTaskComplete: latestOfType(taskReads),
        cvRepairCount,
        hasFinalizeSliceTaskComplete: taskReads.some((r) => r.receipt.payload?.['mode'] === 'finalize-slice'),
        latestRepairTaskComplete: latestOfType(repairTaskCompletes),
    };
}
/**
 * Authoritative CV status (PO-S02-C-04): CV_PASS → PASS; CV_REPAIR → REPAIR
 * (slice back to READY_FOR_CV); a repair-mode TASK_COMPLETE deterministically
 * later than the last CV_REPAIR (cross-category (timestamp, digest) order) →
 * PENDING_RECHECK; no cv receipt → NOT_STARTED (never guessed).
 */
function deriveCvStatus(facts) {
    const latest = facts.latestCv;
    if (latest === null)
        return kernel_1.CVStatus.NOT_STARTED;
    if (latest.receipt.type === 'CV_PASS')
        return kernel_1.CVStatus.PASS;
    // latest is CV_REPAIR: repair-mode TASK_COMPLETE after it → recheck pending.
    if (facts.latestRepairTaskComplete !== null &&
        (0, receipt_reader_1.compareReceiptsByTimestampDigest)(facts.latestRepairTaskComplete, latest) > 0) {
        return kernel_1.CVStatus.PENDING_RECHECK;
    }
    return kernel_1.CVStatus.REPAIR;
}
/**
 * Authoritative committed fact (PO-S02-C-04): a SLICE_COMMIT receipt bound
 * to the latest CV_PASS receipt digest (payload.cv_receipt_digest) with
 * status 'committed'. A missing receipt, a non-PASS latest cv receipt, or a
 * missing/mismatching binding all leave committed false — never a guess.
 */
function deriveCommitted(facts) {
    const commit = facts.latestSliceCommit;
    if (commit === null)
        return false;
    if (commit.receipt.payload?.['status'] !== 'committed')
        return false;
    const latestCv = facts.latestCv;
    if (latestCv === null || latestCv.receipt.type !== 'CV_PASS')
        return false;
    return commit.receipt.payload?.['cv_receipt_digest'] === latestCv.receipt.digest;
}
/**
 * Authoritative integrated fact (PO-S02-C-04): an INTEGRATION_PASS receipt
 * bound to the SAME commit SHA as the committed SLICE_COMMIT. Without a
 * valid committed fact there is no commit SHA to bind to → not integrated.
 */
function deriveIntegrated(facts, committed) {
    if (!committed)
        return false;
    const integration = facts.latestIntegrationPass;
    if (integration === null)
        return false;
    if (integration.receipt.payload?.['status'] !== 'integrated')
        return false;
    const commitSha = facts.latestSliceCommit?.receipt.payload?.['slice_commit_sha'];
    if (typeof commitSha !== 'string' || commitSha.length === 0)
        return false;
    return integration.receipt.payload?.['slice_commit_sha'] === commitSha;
}
/**
 * Normalized per-slice state: raw merged facts + the PO-S02-C-04
 * authoritative derivation (slice_state / cv_status / committed / integrated
 * / complete), deterministically mapped — the most advanced state with
 * positive evidence wins, the safe defaults never guess.
 */
function buildSliceState(sliceDef, git, facts) {
    const tasks = sliceDef.tasks.map((taskId) => ({
        task_id: taskId,
        checked: git?.tasks.find((t) => t.task_id === taskId)?.checked ?? false,
        evidence_written: git?.evidence.find((e) => e.task_id === taskId)?.evidence_written ?? false,
    }));
    const allTasksChecked = git !== undefined && git.tasks.length > 0 && git.tasks.every((t) => t.checked);
    const evidenceFinalized = git?.evidence_finalized ?? false;
    const cvStatus = deriveCvStatus(facts);
    const committed = deriveCommitted(facts);
    const integrated = deriveIntegrated(facts, committed);
    const complete = allTasksChecked && evidenceFinalized && cvStatus === kernel_1.CVStatus.PASS && committed && integrated;
    // slice_state: the most advanced §6 SliceState with positive evidence.
    let sliceState;
    if (facts.latestCv !== null) {
        sliceState =
            facts.latestCv.receipt.type === 'CV_REPAIR'
                ? kernel_1.SliceState.READY_FOR_CV // CV_REPAIR 回 READY_FOR_CV
                : integrated
                    ? kernel_1.SliceState.INTEGRATED
                    : committed
                        ? kernel_1.SliceState.INTEGRATING
                        : kernel_1.SliceState.CV_PASSED;
    }
    else if (allTasksChecked && evidenceFinalized && facts.hasFinalizeSliceTaskComplete) {
        // 全 task checked + evidence finalized + mode=finalize-slice
        // TASK_COMPLETE receipt → READY_FOR_CV.
        sliceState = kernel_1.SliceState.READY_FOR_CV;
    }
    else if (git?.tasks.some((t) => t.checked) === true ||
        git?.evidence.some((e) => e.evidence_written) === true ||
        facts.latestTaskComplete !== null) {
        // Work has begun but the slice has not reached READY_FOR_CV → IN_PROGRESS.
        sliceState = kernel_1.SliceState.IN_PROGRESS;
    }
    else {
        sliceState = kernel_1.SliceState.PLANNED;
    }
    return {
        slice_id: sliceDef.slice_id,
        dependencies: sliceDef.dependencies,
        tasks,
        slice_state: sliceState,
        cv_status: cvStatus,
        slice_evidence_finalized: evidenceFinalized,
        repair_attempt: Math.max(0, facts.cvRepairCount - 1),
        scope_check_passed: false,
        committed,
        integrated,
        complete,
        latest_cv_receipt: facts.latestCv?.receipt ?? null,
        latest_commit_receipt: facts.latestSliceCommit?.receipt ?? null,
    };
}
// ============================================================
// ReconcileService
// ============================================================
/**
 * Reconcile the Manifest + Git + Receipts sources of one stage into a
 * deterministic normalized snapshot with canonical Findings.
 *
 * Deterministic (HP-003) and read-only; never guesses, repairs or writes.
 *
 * @throws {TypeError} when `projectRoot` / `stageId` are missing or empty.
 */
function reconcileStage(input) {
    const { projectRoot, stageId } = input;
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
        throw new TypeError('reconcileStage: projectRoot is required');
    }
    if (typeof stageId !== 'string' || stageId.length === 0) {
        throw new TypeError('reconcileStage: stageId is required');
    }
    const findings = [];
    // ── 1. Manifest source (PO-S02-C-02: missing/invalid/stage-mismatch →
    //        DOMAIN.STAGE_NOT_FOUND; without it no slice structure is known) ──
    let manifest = null;
    try {
        manifest = (0, manifest_source_1.manifestSource)({
            projectRoot,
            stageId,
            manifestPath: input.manifestPath,
        }).manifest;
    }
    catch (err) {
        const reason = err instanceof manifest_source_1.ManifestSourceError ? err.reason : String(err);
        findings.push({
            code: 'DOMAIN.STAGE_NOT_FOUND',
            severity: 'error',
            message: `manifest source unavailable for stage "${stageId}": ${reason}`,
        });
    }
    if (manifest === null) {
        // No slice structure — nothing can be attributed; report the failure and
        // return the empty un-guessed state.
        return emptyResult(stageId, findings);
    }
    const sliceDefs = manifest.slices;
    const knownSlices = new Set(sliceDefs.map((s) => s.slice_id));
    const merge = {
        categoryStates: [],
        validReads: [],
    };
    const baseCtx = { projectRoot, stageId, knownSlices, findings };
    // ── 2. Git source (PO-S02-C-02: non-git root → RUNTIME.SCHEMA_MISMATCH) ──
    let gitHead = null;
    try {
        const gitRoot = (0, git_source_1.resolveGitRoot)(projectRoot);
        gitHead = (0, git_source_1.readGitHead)(gitRoot);
    }
    catch (err) {
        const reason = err instanceof git_source_1.GitSourceError ? err.reason : String(err);
        findings.push({
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message: `git source unavailable: ${reason}`,
        });
    }
    const gitBySlice = new Map();
    if (gitHead !== null) {
        for (const sliceDef of sliceDefs) {
            try {
                gitBySlice.set(sliceDef.slice_id, (0, git_source_1.gitSource)({
                    projectRoot,
                    stageId,
                    sliceId: sliceDef.slice_id,
                    taskIds: sliceDef.tasks,
                    evidencePath: sliceDef.evidence_path,
                    tasksMdPath: input.tasksMdPath,
                }));
            }
            catch (err) {
                const reason = err instanceof git_source_1.GitSourceError ? err.reason : String(err);
                findings.push({
                    code: 'RUNTIME.SCHEMA_MISMATCH',
                    severity: 'error',
                    message: `git source unavailable for slice "${sliceDef.slice_id}": ${reason}`,
                });
            }
        }
    }
    // ── 3. Receipts source (PO-S02-C-03 per-category chain verification; ──
    //        PO-S02-C-05 misplacement; per-declared-slice + stage-level once) ──
    for (const sliceDef of sliceDefs) {
        for (const category of SLICE_LEVEL_CATEGORIES) {
            const result = (0, receipt_reader_1.readReceiptCategory)({
                projectRoot,
                category,
                stageId,
                sliceId: sliceDef.slice_id,
            });
            handleCategoryRead(sliceDef.slice_id, category, result, baseCtx, merge, gitHead);
        }
    }
    for (const category of STAGE_LEVEL_CATEGORIES) {
        const result = (0, receipt_reader_1.readReceiptCategory)({ projectRoot, category, stageId });
        handleCategoryRead(null, category, result, baseCtx, merge, gitHead);
    }
    // Receipt directories referencing slices the manifest does not declare.
    for (const dir of findUnknownSliceDirs(projectRoot, stageId, knownSlices)) {
        findings.push({
            code: 'DOMAIN.STAGE_NOT_FOUND',
            severity: 'error',
            message: `receipts reference unknown slice "${path.basename(dir)}" ` +
                `(directory ${relPath(projectRoot, dir)})`,
        });
    }
    // ── 4. Recoverable warn findings: task checked ↔ evidence missing ──
    //        (PO-S02-C-02 — only when the git facts are actually known)
    for (const sliceDef of sliceDefs) {
        const git = gitBySlice.get(sliceDef.slice_id);
        if (git === undefined)
            continue;
        for (const task of git.tasks) {
            const evidenceWritten = git.evidence.find((e) => e.task_id === task.task_id)?.evidence_written ?? false;
            if (task.checked && !evidenceWritten) {
                findings.push({
                    code: 'RUNTIME.SCHEMA_MISMATCH',
                    severity: 'warn',
                    message: `task "${task.task_id}" is checked in tasks.md but its evidence ` +
                        `section is missing — recoverable`,
                });
            }
            else if (!task.checked && evidenceWritten) {
                findings.push({
                    code: 'RUNTIME.SCHEMA_MISMATCH',
                    severity: 'warn',
                    message: `task "${task.task_id}" has evidence written but is not checked in ` +
                        `tasks.md — recoverable`,
                });
            }
        }
    }
    // ── 5. Assemble the normalized result with the per-slice/stage
    //        authoritative derivation (PO-S02-C-04 / PO-S02-A-05) ──
    const slices = sliceDefs.map((sliceDef) => buildSliceState(sliceDef, gitBySlice.get(sliceDef.slice_id), buildSliceReceiptFacts(merge.validReads, sliceDef.slice_id)));
    // Deterministic flat receipt chain: all valid, attributed receipts of
    // chain-valid categories, ordered by (timestamp, digest), digest only.
    const orderedReads = [...merge.validReads].sort(receipt_reader_1.compareReceiptsByTimestampDigest);
    const receiptChain = orderedReads.map((r) => r.receipt.digest);
    const receiptChainValid = merge.categoryStates.every((c) => c.receipt_chain_valid);
    // Stage derivation through S02-A `deriveStageState` (PO-S02-A-05): slice
    // aggregate facts + stage-boundary receipt presence → unique StageState;
    // READY folds into EXECUTING. A contradictory fact combination throws
    // StageStateDerivationError — surface the canonical DOMAIN.INVALID_TRANSITION
    // Finding and keep the un-guessed UNINITIALIZED default (never a guess).
    const stageReceipts = {
        has_stage_plan: merge.validReads.some((r) => r.receipt.type === 'STAGE_PLAN'),
        has_spv_pass: merge.validReads.some((r) => r.receipt.type === 'SPV_PASS'),
        has_stage_review_pass: merge.validReads.some((r) => r.receipt.type === 'STAGE_REVIEW_PASS'),
    };
    let stageState;
    try {
        stageState = (0, stage_state_1.deriveStageState)({ slices, receipts: stageReceipts });
    }
    catch (err) {
        if (err instanceof stage_state_1.StageStateDerivationError) {
            findings.push({
                code: 'DOMAIN.INVALID_TRANSITION',
                severity: 'error',
                message: err.message,
            });
            stageState = kernel_1.StageState.UNINITIALIZED;
        }
        else {
            throw err;
        }
    }
    return {
        stage_id: stageId,
        slices,
        stage_state: stageState,
        // project_state — deterministic derivation from the persisted facts
        // (HP-003, F-1): a PROJECT_REVIEW_PASS receipt in the shared `project/`
        // category chain proves the project review completed → COMPLETED;
        // otherwise a stage that completed its own stage review (COMPLETED) is
        // the next gate on the project-review path → UNDER_REVIEW; without any
        // positive fact the safe default is IN_PROGRESS (never a guess).
        project_state: deriveProjectState(merge.validReads, stageState),
        receipt_chain: receiptChain,
        findings: sortFindings(findings),
        receipt_chain_valid: receiptChainValid,
        receipt_categories: merge.categoryStates,
    };
}
/**
 * Deterministic project_state derivation from persisted facts (F-1):
 *   - an attributed PROJECT_REVIEW_PASS receipt → COMPLETED;
 *   - else stage COMPLETED (stage review passed, no project review yet) →
 *     UNDER_REVIEW — the project-level review is the gate AFTER the stage
 *     completed its stage review;
 *   - else → IN_PROGRESS (safe default; a missing manifest keeps the
 *     emptyResult default IN_PROGRESS — no facts to judge on).
 */
function deriveProjectState(validReads, stageState) {
    if (validReads.some((r) => r.receipt.type === 'PROJECT_REVIEW_PASS')) {
        return kernel_1.ProjectState.COMPLETED;
    }
    if (stageState === kernel_1.StageState.COMPLETED) {
        return kernel_1.ProjectState.UNDER_REVIEW;
    }
    return kernel_1.ProjectState.IN_PROGRESS;
}
//# sourceMappingURL=reconcile.js.map