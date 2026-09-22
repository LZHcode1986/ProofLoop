import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const roles = [
  'general',
  'worker',
  'researcher',
  'prototype',
  'code-verifier',
  'stage-plan-verifier',
  'stage-reviewer',
  'frontend-execute',
  'frontend-review',
  'proofloop-plan',
];

const missingRole = '__proofloop_missing_role__';
assert.throws(
  () => execFileSync('opencode', ['--pure', 'debug', 'agent', missingRole], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
  'OpenCode missing role must fail closed',
);

for (const role of roles) {
  const effective = JSON.parse(execFileSync('opencode', ['--pure', 'debug', 'agent', role], {
    cwd: root,
    encoding: 'utf8',
  }));
  assert.equal(effective.name, role);
  assert.equal(effective.mode, 'subagent');
}

const effectiveBrain = JSON.parse(execFileSync('opencode', ['--pure', 'debug', 'agent', 'brain'], {
  cwd: root,
  encoding: 'utf8',
}));
assert.equal(effectiveBrain.mode, 'primary');
assert.equal(effectiveBrain.tools.task, true);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'proofloop-host-qualification-'));
try {
  mkdirSync(join(fixtureRoot, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.opencode', 'agents', 'invalid.md'), '---\nmode: invalid\n---\n# invalid\n');
  assert.throws(
    () => execFileSync('opencode', ['--pure', 'debug', 'agent', 'invalid'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
    'OpenCode invalid native config must fail closed',
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  qualification: 'PASS',
  roles,
  checks: [
    'missing/invalid OpenCode config -> fail closed',
    'OpenCode configured roles resolve as native subagents',
    'OpenCode brain resolves as primary with task transport enabled',
  ],
}));
