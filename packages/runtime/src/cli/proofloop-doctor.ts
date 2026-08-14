/**
 * proofloop-doctor.ts — S10-A-T02: doctor domain handler.
 *
 * Contract (tech-spec §0.3 doctor 域, Acceptance A+D, Seam §0.1/§0.2):
 *  - closed operation set: `doctor run` only;
 *  - `--json` canonical envelope: runtime version, Git state (HEAD/clean),
 *    canonical trust root, receipt schema version and a basic read-only state
 *    report — structured diagnostics;
 *  - read-only: this handler never writes any file and never calls any
 *    mutating git command;
 *  - `doctor run --json` must exit 0 (Runtime Proof step s10-cli-doctor-run
 *    shape), so a degraded environment (no git) is REPORTED inside the
 *    envelope, not turned into a process failure.
 *
 * The CLI only consumes closed AI output; doctor reports mechanical facts
 * (root/version/schema/status) and never replaces an AI judgment.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VNEXT_SCHEMA_VERSION } from '@proofloop/kernel';
import {
  CLI_EXIT,
  PROOFLOOP_CLI_SCHEMA_VERSION,
  PROOFLOOP_RUNTIME_VERSION,
  okEnvelope,
  type CliCommand,
  type CliEnvelope,
} from './proofloop-common';

// ============================================================
// Read-only git probes
// ============================================================

interface GitProbeResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function gitProbe(root: string, args: readonly string[]): GitProbeResult {
  try {
    const stdout = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: String(e.stdout ?? '').trim(),
      stderr: String(e.stderr ?? '').trim(),
    };
  }
}

const HEAD_RE = /^[0-9a-f]{40}$/;

function probeGitState(root: string): Record<string, unknown> {
  // `git rev-parse --show-toplevel` distinguishes "git repository present"
  // from "not a git repository"; every command here is read-only.
  const toplevel = gitProbe(root, ['rev-parse', '--show-toplevel']);
  if (!toplevel.ok) {
    return { available: false };
  }
  const headProbe = gitProbe(root, ['rev-parse', 'HEAD']);
  const head = headProbe.ok && HEAD_RE.test(headProbe.stdout) ? headProbe.stdout : null;
  const branchProbe = gitProbe(root, ['branch', '--show-current']);
  const branch = branchProbe.ok && branchProbe.stdout.length > 0 ? branchProbe.stdout : null;
  const porcelainProbe = gitProbe(root, ['status', '--porcelain']);
  const porcelain = porcelainProbe.ok
    ? porcelainProbe.stdout.split('\n').filter((line) => line.length > 0).slice(0, 50)
    : [];
  return {
    available: true,
    root: toplevel.stdout,
    head,
    branch,
    clean: porcelain.length === 0,
    porcelain,
  };
}

// ============================================================
// Read-only capability / state probes
// ============================================================

function dirExists(root: string, relative: string): boolean {
  try {
    return fs.statSync(path.join(root, relative)).isDirectory();
  } catch {
    return false;
  }
}

function probeCapabilities(root: string): Record<string, boolean> {
  return {
    proofloop_dir: dirExists(root, '.proofloop'),
    manifests_dir: dirExists(root, '.proofloop/manifests'),
    receipts_dir: dirExists(root, '.proofloop/receipts'),
    contexts_dir: dirExists(root, '.proofloop/context'),
    runtime_dir: dirExists(root, '.proofloop/runtime'),
  };
}

// ============================================================
// Doctor report
// ============================================================

export interface DoctorReport {
  readonly project_root: string;
  readonly root_source: 'explicit' | 'auto';
  readonly runtime_version: string;
  readonly cli_schema_version: number;
  readonly receipt_schema_version: number;
  readonly git: Record<string, unknown>;
  readonly capabilities: Record<string, boolean>;
  readonly state: {
    readonly read_only: true;
    readonly operations: readonly string[];
  };
}

/**
 * Build the read-only doctor diagnostics for the canonical trust root.
 * Never writes any file; git failures are reported inside `git` (available:
 * false) instead of failing the diagnostic command.
 */
export function runDoctor(
  root: string,
  rootSource: 'explicit' | 'auto',
  command: CliCommand,
): CliEnvelope {
  const report: DoctorReport = {
    project_root: root,
    root_source: rootSource,
    runtime_version: PROOFLOOP_RUNTIME_VERSION,
    cli_schema_version: PROOFLOOP_CLI_SCHEMA_VERSION,
    receipt_schema_version: VNEXT_SCHEMA_VERSION,
    git: probeGitState(root),
    capabilities: probeCapabilities(root),
    state: { read_only: true, operations: ['run'] },
  };
  return okEnvelope(command, report);
}

// ============================================================
// Read-only receipts category probe（doctor status）
// ============================================================

const DOCTOR_RECEIPT_CATEGORIES = [
  'plan',
  'tasks',
  'cv',
  'committer',
  'integration',
  'stage-gate',
  'review',
  'project',
] as const;

/**
 * 只读 receipts 类别摘要：每个 canonical 类别目录的存在性 + `.json` receipt
 * 计数（递归，只读降级 —— 扫描失败保持计数，不 fail closed）。doctor 是
 * structured diagnostics，非法内容属于各域 status 的职责，这里只报告机械事实。
 */
function probeReceiptCategories(
  root: string,
): Record<string, { present: boolean; receipt_count: number }> {
  const out: Record<string, { present: boolean; receipt_count: number }> = {};
  for (const category of DOCTOR_RECEIPT_CATEGORIES) {
    const dir = path.join(root, '.proofloop', 'receipts', category);
    let present = false;
    try {
      present = fs.statSync(dir).isDirectory();
    } catch {
      present = false;
    }
    let count = 0;
    if (present) {
      const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith('.json')) count += 1;
        }
      };
      try {
        walk(dir);
      } catch {
        // 降级：目录中途不可读时保持已统计计数。
      }
    }
    out[category] = { present, receipt_count: count };
  }
  return out;
}

/**
 * `doctor status` — S10-D-T03: doctor 域补 run/status 闭集完整语义。
 * 只读状态报告：与 `doctor run` 相同的机械探测（Git 状态/capabilities/
 * 版本/schema）+ receipts 类别摘要；非 git 仓库降级报告（git.available:
 * false）exit 0；零写入。
 */
export function runDoctorStatus(
  root: string,
  rootSource: 'explicit' | 'auto',
  command: CliCommand,
): CliEnvelope {
  const report = {
    project_root: root,
    root_source: rootSource,
    runtime_version: PROOFLOOP_RUNTIME_VERSION,
    cli_schema_version: PROOFLOOP_CLI_SCHEMA_VERSION,
    receipt_schema_version: VNEXT_SCHEMA_VERSION,
    git: probeGitState(root),
    capabilities: probeCapabilities(root),
    receipts: probeReceiptCategories(root),
    state: { read_only: true, operations: ['run', 'status'] },
  };
  return okEnvelope(command, report);
}

/** Exit code for the doctor domain (read-ready diagnostic report). */
export const DOCTOR_EXIT = CLI_EXIT.OK;
