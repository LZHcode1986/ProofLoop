/**
 * run-gate.spec.ts — service lifecycle + command/probe oracles (B1b)
 *
 * Real-spawn coverage for the run-gate service lifecycle (blueprint §11 via
 * the B1a process-runner), with parity to the legacy
 * `.agents/runtime/src/run-stage.ts` executeRuntimeProof semantics:
 *
 *   service_start  — spawn → register → (readiness wait) → stop on failure
 *   service_stop   — registry lookup by service_ref (or step id) → stop
 *   cleanup        — mandatory at Gate end (PASS or FAIL); a still-running
 *                    service with a DECLARED service_stop step = "explicit
 *                    stop was missed" → Gate FAIL; no process leaks
 *   command/probe  — runProcess oracle: expected.exit_code (null = any),
 *                    timeout, not_applicable skip
 *
 * No mocks: every test spawns real `node -e` child processes with short
 * timeouts. Leak checks read the spawned PID from a marker file and probe
 * liveness after the gate; the registry is verified empty afterwards.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Manifest } from '@proofloop/kernel';
import { validateManifest } from '@proofloop/kernel';
import { runGate, runGateCli } from './run-gate';
import { getRegisteredService } from '../process-runner';
import { isProcessAlive } from '../platform-adapter';

// ============================================================
// Fixture helpers
// ============================================================

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-H';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeManifest(steps: Array<Record<string, unknown>>): Manifest {
  return {
    stage_id: STAGE_ID,
    source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
    source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
    stage_goal: 'Runtime CLI surface',
    outcomes: ['service lifecycle'],
    slices: [
      {
        slice_id: SLICE_ID,
        goal: 'CLI entries',
        observable_outcome: 'callable CLI entries with zero host deps',
        public_seam: 'packages/runtime/dist/cli',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-H-01',
            behavior: 'CLI call matrix',
            public_seam: 'dist cli entries',
            oracle_source: 'legacy CLI contract',
            success_criteria: 'success + failure cases pass',
            required_observation: 'fixture oracle',
            applicable_risk_facts: ['public_api_change'],
          },
        ],
        tasks: ['S03-H-T01'],
        risk_facts: ['persistent_state'],
        evidence_path: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
    runtime_proof: steps as unknown as Manifest['runtime_proof'],
  };
}

interface GateFixture {
  readonly dir: string;
  readonly result: Awaited<ReturnType<typeof runGate>>;
}

/** Write manifest + facts into a fresh temp dir and run the gate. */
async function gateFixture(steps: Array<Record<string, unknown>>): Promise<GateFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  const manifest = makeManifest(steps);
  expect(() => validateManifest(manifest)).not.toThrow();
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  const factsPath = path.join(dir, 'facts.json');
  fs.writeFileSync(factsPath, JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
  const result = await runGate({
    manifestPath,
    factsPath,
    outputDir: path.join(dir, 'out'),
    projectRoot: dir,
  });
  return { dir, result };
}

/**
 * service_start step that writes its PID to a marker file, then idles.
 * Emits "PIDREADY" AFTER the synchronous pid-file write, so declaring
 * `readiness_signal: 'PIDREADY'` guarantees the marker exists once the gate
 * proceeds past the start step (the pid-file write would otherwise race the
 * fast path into cleanup).
 */
function pidFileService(id: string, pidFile: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'service_start',
    executable: 'node',
    args: ['-e', `require('fs').writeFileSync(process.argv[1], String(process.pid)); console.log("PIDREADY");setInterval(()=>{},1000)`, pidFile],
    cwd: '.',
    timeout_ms: 10000,
    readiness_signal: 'PIDREADY',
    ...overrides,
  };
}

/** service_stop step (executable/args/cwd/timeout_ms required by the kernel validator). */
function stopStep(id: string, ref?: string): Record<string, unknown> {
  return {
    id,
    type: 'service_stop',
    executable: 'node',
    args: [],
    cwd: '.',
    timeout_ms: 10000,
    ...(ref !== undefined ? { service_ref: ref } : {}),
  };
}

/** command step — scripts must avoid shell operator chars (runProcess enforces). */
function commandStep(id: string, script: string, expected: unknown, timeoutMs = 10000): Record<string, unknown> {
  return {
    id,
    type: 'command',
    executable: 'node',
    args: ['-e', script],
    cwd: '.',
    timeout_ms: timeoutMs,
    ...(expected !== undefined ? { expected } : {}),
  };
}

/** Read the marker file's PID and probe whether the process is still alive. */
function pidAlive(pidFile: string): boolean {
  const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
  return isProcessAlive(pid);
}

// ============================================================
// service_start
// ============================================================

describe('run-gate service_start', () => {
  it('spawns, registers and implicitly cleans up a service on PASS (no declared stop)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    const pidFile = path.join(dir, 'svc.pid');
    const { result } = await gateFixture([pidFileService('svc', pidFile)]);
    expect(result.gate).toBe('PASS');
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.steps[0]).toMatchObject({ id: 'svc', type: 'service_start', passed: true, exit_code: 0 });
    expect(result.steps[0].observations).toContain('Service started, PID');
    // registry empty + process actually gone after the mandatory cleanup
    expect(getRegisteredService('svc')).toBeUndefined();
    expect(pidAlive(pidFile)).toBe(false);
  });

  it('PASSes when the readiness signal appears within the timeout', async () => {
    const { result } = await gateFixture([
      {
        id: 'app',
        type: 'service_start',
        executable: 'node',
        args: ['-e', 'console.log("READY");setInterval(()=>{},1000)'],
        cwd: '.',
        timeout_ms: 10000,
        readiness_signal: 'READY',
      },
    ]);
    expect(result.gate).toBe('PASS');
    expect(result.steps[0]).toMatchObject({ id: 'app', passed: true, exit_code: 0 });
    expect(result.steps[0].observations).toContain('Readiness signal found after');
    expect(getRegisteredService('app')).toBeUndefined();
  });

  it('FAILs on readiness timeout and STOPS the service (no leak)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    const pidFile = path.join(dir, 'svc.pid');
    const { result } = await gateFixture([
      pidFileService('svc', pidFile, { readiness_signal: 'NEVER', timeout_ms: 500 }),
    ]);
    expect(result.gate).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ id: 'svc', passed: false, exit_code: null });
    expect(result.errors.join(' ')).toContain('readiness signal "NEVER" not found within 500ms');
    // must not leak: registry empty + process dead
    expect(getRegisteredService('svc')).toBeUndefined();
    expect(pidAlive(pidFile)).toBe(false);
  });

  it('FAILs when the process exits before the readiness signal (exit code recorded)', async () => {
    const { result } = await gateFixture([
      {
        id: 'svc',
        type: 'service_start',
        executable: 'node',
        args: ['-e', 'process.exit(7)'],
        cwd: '.',
        timeout_ms: 5000,
        readiness_signal: 'READY',
      },
    ]);
    expect(result.gate).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ id: 'svc', passed: false, exit_code: 7 });
    expect(result.errors.join(' ')).toContain('exited (code 7) before readiness signal');
  });

  it('FAILs when the executable cannot be spawned (ENOENT)', async () => {
    const { result } = await gateFixture([
      {
        id: 'svc',
        type: 'service_start',
        executable: 'no-such-binary-abc',
        args: [],
        cwd: '.',
        timeout_ms: 5000,
      },
    ]);
    expect(result.gate).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ id: 'svc', passed: false, exit_code: null });
    expect(result.errors.join(' ')).toContain('service_start');
  });
});

// ============================================================
// service_stop
// ============================================================

describe('run-gate service_stop', () => {
  it('terminates a registered service referenced by service_ref', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    const pidFile = path.join(dir, 'app.pid');
    const { result } = await gateFixture([
      pidFileService('start-app', pidFile),
      stopStep('stop-app', 'start-app'),
    ]);
    expect(result.gate).toBe('PASS');
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.steps[0]).toMatchObject({ id: 'start-app', passed: true, exit_code: 0 });
    expect(result.steps[1]).toMatchObject({ id: 'stop-app', passed: true, exit_code: 0 });
    expect(result.steps[1].observations).toContain('Service stopped (PID');
    // the explicit stop already removed the service: no cleanup needed, no leak
    expect(getRegisteredService('start-app')).toBeUndefined();
    expect(pidAlive(pidFile)).toBe(false);
  });

  it('FAILs when the referenced service is not registered', async () => {
    const { result } = await gateFixture([stopStep('stop-app', 'ghost')]);
    expect(result.gate).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ id: 'stop-app', passed: false, exit_code: null });
    expect(result.errors.join(' ')).toContain('no registered service found for ref "ghost"');
  });

  it('FAILs when service_stop has no service_ref and the step id is unregistered', async () => {
    const { result } = await gateFixture([stopStep('orphan')]);
    expect(result.gate).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('no registered service found for ref "orphan"');
  });
});

// ============================================================
// cleanup semantics
// ============================================================

describe('run-gate cleanup', () => {
  it('treats a missed explicit service_stop as a Gate FAIL and still cleans up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    const pidFile = path.join(dir, 'svc.pid');
    // The command step fails → execution stops → the declared service_stop
    // never runs → cleanup stops the service → "explicit stop was missed".
    const { result } = await gateFixture([
      pidFileService('svc', pidFile),
      commandStep('boom', 'process.exit(1)', { exit_code: 0 }),
      stopStep('stop-svc', 'svc'),
    ]);
    expect(result.gate).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('explicit stop was missed');
    expect(result.errors.join(' ')).toContain('svc');
    // cleanup still killed the process — no leak
    expect(pidAlive(pidFile)).toBe(false);
    expect(getRegisteredService('svc')).toBeUndefined();
    // the stop step never executed (break on first failure)
    expect(result.steps.map((s) => s.id)).toEqual(['svc', 'boom']);
  });

  it('cleans up services on failure WITHOUT a declared stop (no missed-stop error)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    const pidFile = path.join(dir, 'svc.pid');
    const { result } = await gateFixture([
      pidFileService('svc', pidFile),
      commandStep('boom', 'process.exit(1)', { exit_code: 0 }),
    ]);
    expect(result.gate).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('exited 1');
    expect(result.errors.join(' ')).not.toContain('explicit stop was missed');
    // implicit cleanup stopped the service — no leak
    expect(pidAlive(pidFile)).toBe(false);
    expect(getRegisteredService('svc')).toBeUndefined();
  });

  it('does not fire missed-stop when a skipped (not_applicable) stop step is declared but the service was never started', async () => {
    const { result } = await gateFixture([
      commandStep('ok', 'process.exit(0)', { exit_code: 0 }),
      { ...stopStep('stop-svc', 'svc'), not_applicable: { reason: 'no service in library stage' } },
    ]);
    expect(result.gate).toBe('PASS');
    expect(result.steps[1]).toMatchObject({ id: 'stop-svc', passed: true, skipped: true });
  });
});

// ============================================================
// command / probe oracles (regression)
// ============================================================

describe('run-gate command/probe oracles', () => {
  it('accepts any exit code when expected.exit_code is null', async () => {
    const { result } = await gateFixture([commandStep('any', 'process.exit(5)', { exit_code: null })]);
    expect(result.gate).toBe('PASS');
    expect(result.steps[0]).toMatchObject({ id: 'any', passed: true, exit_code: 5 });
  });

  it('FAILs a mismatched exit code with stderr context', async () => {
    const { result } = await gateFixture([commandStep('bad', 'process.exit(2)', { exit_code: 0 })]);
    expect(result.gate).toBe('FAIL');
    expect(result.steps[0]).toMatchObject({ id: 'bad', passed: false, exit_code: 2 });
    expect(result.errors.join(' ')).toContain('exited 2, expected 0');
  });

  it('FAILs a step that exceeds its timeout', async () => {
    const { result } = await gateFixture([
      commandStep('tmo', 'setTimeout(function(){},10000)', { exit_code: 0 }, 300),
    ]);
    expect(result.gate).toBe('FAIL');
    expect(result.errors.join(' ')).toContain('timed out after 300ms');
    expect(result.steps[0]).toMatchObject({ id: 'tmo', passed: false, exit_code: null });
  });

  it('skips not_applicable steps and continues', async () => {
    const { result } = await gateFixture([
      commandStep('na', 'process.exit(9)', { exit_code: 0 }),
      commandStep('ok', 'process.exit(0)', { exit_code: 0 }),
    ].map((s, i) => (i === 0 ? { ...s, not_applicable: { reason: 'skipped' } } : s)));
    expect(result.gate).toBe('PASS');
    expect(result.steps[0]).toMatchObject({ id: 'na', passed: true, skipped: true });
    expect(result.steps[1]).toMatchObject({ id: 'ok', passed: true });
  });
});

// ============================================================
// CLI exit semantics
// ============================================================

describe('run-gate CLI', () => {
  it('runGateCli returns 0 on PASS and prints the result JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest([
      commandStep('ok', 'process.exit(0)', { exit_code: 0 }),
    ]), null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
    const code = await runGateCli([path.join(dir, 'manifest.json'), path.join(dir, 'facts.json'), path.join(dir, 'out'), dir]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'out', 'gate-result.json'))).toBe(true);
  });

  it('runGateCli returns 1 on FAIL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rungate-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(makeManifest([
      commandStep('boom', 'process.exit(1)', { exit_code: 0 }),
    ]), null, 2), 'utf-8');
    fs.writeFileSync(path.join(dir, 'facts.json'), JSON.stringify([{ slice_id: SLICE_ID, integrated: true }]), 'utf-8');
    const code = await runGateCli([path.join(dir, 'manifest.json'), path.join(dir, 'facts.json'), path.join(dir, 'out'), dir]);
    expect(code).toBe(1);
  });

  it('runGateCli returns 1 with usage text when args are missing', async () => {
    const code = await runGateCli([]);
    expect(code).toBe(1);
  });
});
