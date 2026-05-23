import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNpmLockfile } from '../dist/detectors/npm-lockfile.js';
import { makeOldNewFixture } from 'agent-gov-core/test-utils';

function buildLockfile(packages) {
  return JSON.stringify(
    {
      name: 'app',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages
    },
    null,
    2
  );
}

async function makeFixture(oldPackages, newPackages) {
  const fx = await makeOldNewFixture({
    old: { 'package-lock.json': buildLockfile(oldPackages) },
    new: { 'package-lock.json': buildLockfile(newPackages) }
  });
  return { oldRoot: fx.old, newRoot: fx.new, cleanup: fx.cleanup };
}

test('flags transitive high-capability dep added to package-lock.json', async () => {
  const fixture = await makeFixture(
    { '': { name: 'app' }, 'node_modules/lodash': { version: '4.17.21' } },
    {
      '': { name: 'app' },
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/parent/node_modules/node-fetch': { version: '3.0.0' }
    }
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'node-fetch');
    assert.ok(f);
    assert.equal(f.kind, 'capability_echo.lockfile_high_capability_dep_added');
    assert.equal(f.severity, 'high');
  } finally {
    await fixture.cleanup();
  }
});

test('flags scoped transitive deps correctly', async () => {
  const fixture = await makeFixture(
    { '': { name: 'app' } },
    {
      '': { name: 'app' },
      'node_modules/@sentry/node': { version: '8.0.0' }
    }
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === '@sentry/node');
    assert.ok(f);
    assert.equal(f.kind, 'capability_echo.lockfile_telemetry_dep_added');
    assert.equal(f.severity, 'medium');
  } finally {
    await fixture.cleanup();
  }
});

test('flags newly-added package that declares an install script', async () => {
  const fixture = await makeFixture(
    { '': { name: 'app' } },
    {
      '': { name: 'app' },
      'node_modules/native-thing': { version: '1.0.0', hasInstallScript: true }
    }
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.kind === 'capability_echo.lockfile_install_script_added');
    assert.ok(f);
    assert.equal(f.subject, 'native-thing');
    assert.equal(f.severity, 'high');
  } finally {
    await fixture.cleanup();
  }
});

test('does not flag pre-existing transitive deps', async () => {
  const fixture = await makeFixture(
    {
      '': { name: 'app' },
      'node_modules/node-fetch': { version: '3.0.0' }
    },
    {
      '': { name: 'app' },
      'node_modules/node-fetch': { version: '3.1.0' }
    }
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('skips non-node_modules entries and the root package', async () => {
  const fixture = await makeFixture(
    { '': { name: 'app' } },
    {
      '': { name: 'app', dependencies: { 'something-internal': '0' } },
      'workspaces/internal': { version: '1.0.0' }
    }
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('annotates the lockfile key line', async () => {
  const fixture = await makeFixture(
    { '': { name: 'app' } },
    {
      '': { name: 'app' },
      'node_modules/puppeteer': { version: '22.0.0' }
    }
  );
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const text = await readFile(join(fixture.newRoot, 'package-lock.json'), 'utf8');
    const keyLine = text.split(/\r?\n/).findIndex((l) => l.includes('"node_modules/puppeteer"')) + 1;

    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'puppeteer');
    assert.ok(f);
    assert.equal(f.line, keyLine);
  } finally {
    await fixture.cleanup();
  }
});
