import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPackageDeps } from '../dist/detectors/package-deps.js';
import { makeOldNewFixture } from 'agent-gov-core/test-utils';

async function makeFixture(oldPackage, newPackage) {
  const oldText = JSON.stringify(oldPackage, null, 2);
  const newText = JSON.stringify(newPackage, null, 2);
  const fx = await makeOldNewFixture({
    old: { 'package.json': oldText },
    new: { 'package.json': newText },
  });
  return { oldRoot: fx.old, newRoot: fx.new, inputs: [{ file: 'package.json', oldText, newText }], cleanup: fx.cleanup };
}

test('flags newly added high-capability dep (puppeteer)', async () => {
  const fixture = await makeFixture(
    { name: 'app', dependencies: { lodash: '^4.0.0' } },
    { name: 'app', dependencies: { lodash: '^4.0.0', puppeteer: '^22.0.0' } }
  );
  try {
    const findings = detectPackageDeps(fixture.inputs);
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
    const findings = detectPackageDeps(fixture.inputs);
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
    const findings = detectPackageDeps(fixture.inputs);
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
    const findings = detectPackageDeps(fixture.inputs);
    assert.ok(findings.find((f) => f.subject === 'node-fetch'));
    assert.ok(findings.find((f) => f.subject === 'execa'));
  } finally {
    await fixture.cleanup();
  }
});

test('annotates the dependency key when its version string is shared with another dep', async () => {
  const fixture = await makeFixture(
    { name: 'app', dependencies: { lodash: '^4.0.0' } },
    { name: 'app', dependencies: { lodash: '^4.0.0', puppeteer: '^4.0.0' } }
  );
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const newPackage = await readFile(join(fixture.newRoot, 'package.json'), 'utf8');
    const newLines = newPackage.split(/\r?\n/);
    const puppeteerLine = newLines.findIndex((l) => l.includes('"puppeteer"')) + 1;

    const findings = detectPackageDeps(fixture.inputs);
    const f = findings.find((finding) => finding.subject === 'puppeteer');
    assert.ok(f);
    assert.equal(f.line, puppeteerLine, `expected line ${puppeteerLine} (puppeteer key), got ${f.line}`);
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
    const findings = detectPackageDeps(fixture.inputs);
    assert.equal(findings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});
