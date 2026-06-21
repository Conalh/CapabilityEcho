import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function buildLockfileV1(dependencies) {
  return JSON.stringify(
    {
      name: 'app',
      version: '0.0.0',
      lockfileVersion: 1,
      requires: true,
      dependencies
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

async function makeLockfileTextFixture(oldText, newText) {
  const fx = await makeOldNewFixture({
    old: { 'package-lock.json': oldText },
    new: { 'package-lock.json': newText }
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

test('flags changed high-capability transitive deps', async () => {
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
    const f = findings.find((finding) => finding.subject === 'node-fetch');
    assert.ok(f, 'high-capability lockfile version changes should be re-reviewed');
    assert.equal(f.kind, 'capability_echo.lockfile_high_capability_dep_added');
  } finally {
    await fixture.cleanup();
  }
});

test('does not flag unchanged pre-existing transitive deps', async () => {
  const fixture = await makeFixture(
    {
      '': { name: 'app' },
      'node_modules/node-fetch': { version: '3.0.0' }
    },
    {
      '': { name: 'app' },
      'node_modules/node-fetch': { version: '3.0.0' }
    }
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('flags install script added to an existing lockfile package', async () => {
  const fixture = await makeFixture(
    {
      '': { name: 'app' },
      'node_modules/native-thing': { version: '1.0.0' }
    },
    {
      '': { name: 'app' },
      'node_modules/native-thing': { version: '1.0.0', hasInstallScript: true }
    }
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.kind === 'capability_echo.lockfile_install_script_added');
    assert.ok(f, 'install-script flips should not be hidden by stable lockfile paths');
    assert.equal(f.subject, 'native-thing');
  } finally {
    await fixture.cleanup();
  }
});

test('flags high-capability deps in package-lock v1 dependency maps', async () => {
  const fixture = await makeLockfileTextFixture(
    buildLockfileV1({
      lodash: { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' }
    }),
    buildLockfileV1({
      lodash: { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
      'node-fetch': { version: '3.3.2', resolved: 'https://registry.npmjs.org/node-fetch/-/node-fetch-3.3.2.tgz' }
    })
  );
  try {
    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'node-fetch');
    assert.ok(f, 'lockfile v1 dependencies should be scanned');
    assert.equal(f.kind, 'capability_echo.lockfile_high_capability_dep_added');
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

test('directory mode does not follow symlinked npm lockfiles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capabilityecho-lockfile-symlink-'));
  const oldRoot = join(root, 'old');
  const newRoot = join(root, 'new');
  const outside = join(root, 'outside');
  await mkdir(oldRoot, { recursive: true });
  await mkdir(newRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    join(outside, 'package-lock.json'),
    buildLockfile({
      '': { name: 'app' },
      'node_modules/node-fetch': { version: '3.0.0' }
    })
  );

  try {
    try {
      symlinkSync(join(outside, 'package-lock.json'), join(newRoot, 'package-lock.json'));
    } catch (error) {
      t.skip(`symlink creation not permitted on this platform (${error.code})`);
      return;
    }

    const findings = await detectNpmLockfile({ mode: 'directories', oldRoot, newRoot });
    assert.equal(findings.length, 0, 'symlinked lockfile outside the tree must not be scanned');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
