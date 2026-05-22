import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPackageDeps } from '../dist/detectors/package-deps.js';
import { makeOldNewFixture } from 'agent-gov-core/test-utils';

async function makeFixture(oldPackage, newPackage) {
  const fx = await makeOldNewFixture({
    old: { 'package.json': JSON.stringify(oldPackage, null, 2) },
    new: { 'package.json': JSON.stringify(newPackage, null, 2) },
  });
  return { oldRoot: fx.old, newRoot: fx.new, cleanup: fx.cleanup };
}

test('flags newly added high-capability dep (puppeteer)', async () => {
  const fixture = await makeFixture(
    { name: 'app', dependencies: { lodash: '^4.0.0' } },
    { name: 'app', dependencies: { lodash: '^4.0.0', puppeteer: '^22.0.0' } }
  );
  try {
    const findings = await detectPackageDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.kind === 'capability_echo.high_capability_dep_added');
    assert.ok(f);
    assert.equal(f.subject, 'puppeteer');
    assert.equal(f.severity, 'high');
  } finally {
    await fixture.cleanup();
  }
});

test('does not flag pre-existing deps', async () => {
  const fixture = await makeFixture(
    { name: 'app', dependencies: { puppeteer: '^22.0.0' } },
    { name: 'app', dependencies: { puppeteer: '^22.0.0', 'lodash': '^4.0.0' } }
  );
  try {
    const findings = await detectPackageDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.find((f) => f.kind === 'capability_echo.high_capability_dep_added'), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('flags telemetry dep at medium severity', async () => {
  const fixture = await makeFixture(
    { name: 'app', dependencies: {} },
    { name: 'app', dependencies: { '@sentry/node': '^8.0.0' } }
  );
  try {
    const findings = await detectPackageDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.kind === 'capability_echo.telemetry_dep_added');
    assert.ok(f);
    assert.equal(f.severity, 'medium');
  } finally {
    await fixture.cleanup();
  }
});

test('finds deps added to devDependencies and optionalDependencies', async () => {
  const fixture = await makeFixture(
    { name: 'app' },
    { name: 'app', devDependencies: { 'node-fetch': '^3.0.0' }, optionalDependencies: { execa: '^9.0.0' } }
  );
  try {
    const findings = await detectPackageDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.ok(findings.find((f) => f.subject === 'node-fetch'));
    assert.ok(findings.find((f) => f.subject === 'execa'));
  } finally {
    await fixture.cleanup();
  }
});

test('ignores benign dep additions (no false positives)', async () => {
  const fixture = await makeFixture(
    { name: 'app', dependencies: { lodash: '^4.0.0' } },
    { name: 'app', dependencies: { lodash: '^4.0.0', 'date-fns': '^3.0.0', 'zod': '^3.22.0' } }
  );
  try {
    const findings = await detectPackageDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});
