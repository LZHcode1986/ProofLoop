import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
  'proofloop-plan',
];

function blocker(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rolePath(host, role) {
  return host === 'pi'
    ? join(root, '.pi', 'agents', `${role}.md`)
    : join(root, '.opencode', 'agents', `${role}.md`);
}

function checkedRolePath(host, requestedRole, candidatePath) {
  const expectedBasename = basename(candidatePath, '.md');
  if (expectedBasename !== requestedRole) {
    throw blocker('RUNTIME_BLOCKER', `role identity mismatch: requested ${requestedRole}, configured ${expectedBasename}`);
  }
  if (!existsSync(candidatePath)) {
    throw blocker('RUNTIME_BLOCKER', `role config is missing: ${candidatePath}`);
  }
  return resolve(candidatePath);
}

function requireStructuredResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw blocker('RESULT_MISSING', 'structured Subagent Result is missing');
  }
  return value;
}

function assertNativeFrontmatter(host, text, role) {
  const validMode = host === 'pi' ? /^prompt_mode: replace$/m.test(text) : /^mode: subagent$/m.test(text);
  if (!validMode || !/^---$/m.test(text) || !/^# /m.test(text)) {
    throw blocker('RUNTIME_BLOCKER', `${host}/${role}: native config is malformed`);
  }
}

for (const host of ['pi', 'opencode']) {
  for (const role of roles) {
    const path = rolePath(host, role);
    const text = readFileSync(path, 'utf8');
    assert.equal(checkedRolePath(host, role, path), resolve(path));
    assertNativeFrontmatter(host, text, role);
    assert.ok(!text.includes(`.agents/skills/${role}/SKILL.md`), `${host}/${role} must own its procedure`);
  }
}

const piPlanner = readFileSync(rolePath('pi', 'proofloop-plan'), 'utf8');
const openCodePlanner = readFileSync(rolePath('opencode', 'proofloop-plan'), 'utf8');
const plannerMarkers = [
  'MAP CHECK',
  'BIND',
  'TRACE',
  'COMPOSE SLICES',
  'VALIDATE SLICE TOPOLOGY',
  'DECOMPOSE TASKS BY SLICE',
  'RECONCILE',
  'CLOSE',
  'FREEZE',
  'RETURN CANDIDATE_PLAN_READY',
];
for (const marker of plannerMarkers) {
  assert.ok(piPlanner.includes(marker), `Pi Planner missing ${marker}`);
  assert.ok(openCodePlanner.includes(marker), `OpenCode Planner missing ${marker}`);
}
assert.match(piPlanner, /Agent.*resume.*get_subagent_result/s);
assert.match(openCodePlanner, /task.*sessionID.*returned/s);

const piBrain = readFileSync(join(root, '.pi', 'brain-workflow.md'), 'utf8');
const openCodeBrain = readFileSync(join(root, '.opencode', 'agents', 'brain.md'), 'utf8');
const lifecycleContract = readFileSync(join(root, '.agents', 'contracts', 'brain', 'agent-lifecycle.md'), 'utf8');

assert.match(piBrain, /Agent[\s\S]*get_subagent_result/);
assert.match(piBrain, /resume[\s\S]*steer_subagent[\s\S]*successor Task/);
assert.match(piBrain, /target\/basis[\s\S]*Reviewer continuation/);
assert.match(piBrain, /SPV[\s\S]*fresh full initial/);
assert.match(openCodeBrain, /continuation-first/);
assert.match(openCodeBrain, /logical owner/);
assert.match(openCodeBrain, /不复制 Pi 的 `steer_subagent`/);
assert.match(openCodeBrain, /same-owner continuation/);
assert.match(openCodeBrain, /SPV[\s\S]*fresh full initial/);
assert.match(lifecycleContract, /Continuation Relay Rule/);
assert.match(lifecycleContract, /not a lifecycle, MES fact, Plan\/Authority fact, durable state/);
assert.match(lifecycleContract, /pending Result or closed ACK barrier/);
const piWorker = readFileSync(rolePath('pi', 'worker'), 'utf8');
const openCodeWorker = readFileSync(rolePath('opencode', 'worker'), 'utf8');
assert.match(piWorker, /同一 binding current/);
assert.match(piWorker, /session loss.*recovery\/fresh/);
assert.match(openCodeWorker, /同一 binding current/);
assert.match(openCodeWorker, /sessionID/);
assert.match(openCodeWorker, /session loss.*recovery\/fresh/);

assert.throws(
  () => checkedRolePath('pi', 'worker', rolePath('pi', 'general')),
  (error) => error?.code === 'RUNTIME_BLOCKER',
);
assert.throws(
  () => checkedRolePath('opencode', 'missing-role', join(root, '.opencode', 'agents', 'missing-role.md')),
  (error) => error?.code === 'RUNTIME_BLOCKER',
);
assert.throws(
  () => requireStructuredResult(null),
  (error) => error?.code === 'RESULT_MISSING',
);
assert.throws(
  () => assertNativeFrontmatter('pi', '---\n# malformed\n', 'invalid'),
  (error) => error?.code === 'RUNTIME_BLOCKER',
);

const missingRole = '__proofloop_missing_role__';
assert.throws(
  () => execFileSync('opencode', ['--pure', 'debug', 'agent', missingRole], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  'OpenCode missing role must fail closed',
);
for (const role of roles) {
  const effective = JSON.parse(execFileSync('opencode', ['--pure', 'debug', 'agent', role], { cwd: root, encoding: 'utf8' }));
  assert.equal(effective.name, role);
  assert.equal(effective.mode, 'subagent');
  assert.ok(effective.prompt.length > 500, `${role}: effective prompt is unexpectedly short`);
}
const effectiveBrain = JSON.parse(execFileSync('opencode', ['--pure', 'debug', 'agent', 'brain'], { cwd: root, encoding: 'utf8' }));
assert.equal(effectiveBrain.mode, 'primary');
assert.equal(effectiveBrain.tools.task, true);
assert.ok(effectiveBrain.prompt.includes('OpenCode'));

const fixtureRoot = mkdtempSync(join(tmpdir(), 'proofloop-host-qualification-'));
try {
  mkdirSync(join(fixtureRoot, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(fixtureRoot, '.opencode', 'agents', 'invalid.md'), '---\nmode: invalid\n---\n# invalid\n');
  assert.throws(
    () => execFileSync('opencode', ['--pure', 'debug', 'agent', 'invalid'], { cwd: fixtureRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    'OpenCode invalid native config must fail closed',
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  qualification: 'PASS',
  roles,
  checks: [
    'role identity mismatch -> RUNTIME_BLOCKER',
    'missing/invalid OpenCode config -> fail closed',
    'missing structured Result -> RESULT_MISSING',
    'same Worker continuation markers',
    'session-loss recovery markers',
    'Pi prompt replacement and transport markers',
    'OpenCode effective prompt/debug route',
    'Pi resume/steer_subagent/result retrieval and ACK barrier markers',
    'OpenCode continuation-first same-owner relay markers',
    'Host-neutral relay contract no-durable-state markers',
  ],
}));
