import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPackageDeps } from '../dist/detectors/package-deps.js';

async function makeFixture(oldPackage, newPackage) {
  const root = await mkdtemp(join(tmpdir(), 'ce-deps-'));
  const oldRoot = join(root, 'old');
  const newRoot = join(root, 'new');
  await mkdir(oldRoot, { recursive: true });
  await mkdir(newRoot, { recursive: true });
  await writeFile(join(oldRoot, 'package.json'), JSON.stringify(oldPackage, null, 2));
  await writeFile(join(newRoot, 'package.json'), JSON.stringify(newPackage, null, 2));
  return { root, oldRoot, newRoot };
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
    await rm(fixture.root, { recursive: true, force: true });
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
    await rm(fixture.root, { recursive: true, force: true });
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
    await rm(fixture.root, { recursive: true, force: true });
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
    await rm(fixture.root, { recursive: true, force: true });
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
    await rm(fixture.root, { recursive: true, force: true });
  }
});
