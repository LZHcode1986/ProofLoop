import type {} from 'node:test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helperModule = fs.existsSync(path.join(__dirname, 'slice-boundary-e2e-helper.js'))
  ? './slice-boundary-e2e-helper.js'
  : './slice-boundary-e2e-helper.ts';
const { buildSliceBoundaryFixture } = require(helperModule);

test('real vNext slice boundary recipe', () => {
  const fixture = buildSliceBoundaryFixture();
  try {
    assert.equal(fixture.compile.success, true);
    assert.equal(fixture.composition.closure_valid, true);
    assert.equal(fixture.stagePlan.accepted, true);
    assert.equal(fixture.worker.accepted, true);
    assert.equal(fixture.cv.accepted, true);
    assert.equal(fixture.boundary.ok, true);
    assert.equal(fixture.stageCommit.ok, true);
    assert.equal(fixture.committerReceipt.payload.commit_sha, fixture.boundary.result.commit_sha);
    assert.equal(fixture.committerReceipt.payload.cv_receipt_digest, fixture.cv.receipt_ref);
    assert.equal(fixture.committerReceipt.digest, fixture.committerRef.digest);
    assert.equal(fs.existsSync(fixture.committerPath), true);

    console.log('compileVNextPlan success');
    console.log('auditVNextStageComposition closure_valid');
    console.log('admitVNextStagePlan accepted');
    console.log('worker accepted');
    console.log('cv accepted');
    console.log(`boundary close commit_sha ${fixture.boundary.result.commit_sha}`);
    console.log('stage admit-slice-commit accepted');
    console.log(`final committer receipt ${fixture.committerRef.ref}:`);
    console.log(JSON.stringify(fixture.committerReceipt, null, 2));
  } finally {
    fixture.cleanup();
  }
});
