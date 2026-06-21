import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPackageScripts } from '../dist/detectors/package-scripts.js';
import { makeOldNewFixture } from 'agent-gov-core/test-utils';

async function makeFixture(oldPackage, newPackage) {
  const fx = await makeOldNewFixture({
    old: { 'package.json': JSON.stringify(oldPackage, null, 2) },
    new: { 'package.json': JSON.stringify(newPackage, null, 2) },
  });
  return { oldRoot: fx.old, newRoot: fx.new, cleanup: fx.cleanup };
}

test('package scripts do not flag semver-pinned npx commands as unpinned network commands', async () => {
  const fixture = await makeFixture(
    { name: 'app', scripts: {} },
    { name: 'app', scripts: { lint: 'npx eslint@1.2.3 .' } }
  );
  try {
    const findings = await detectPackageScripts({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.find((finding) => finding.kind === 'capability_echo.script_network_command'), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('package scripts still flag unpinned npx commands', async () => {
  const fixture = await makeFixture(
    { name: 'app', scripts: {} },
    { name: 'app', scripts: { lint: 'npx eslint .' } }
  );
  try {
    const findings = await detectPackageScripts({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.ok(findings.find((finding) => finding.kind === 'capability_echo.script_network_command'));
  } finally {
    await fixture.cleanup();
  }
});

test('package scripts do not label local PowerShell Invoke-Expression as remote pipe-to-shell', async () => {
  const fixture = await makeFixture(
    { name: 'app', scripts: {} },
    { name: 'app', scripts: { local: 'powershell -Command "Invoke-Expression $env:LOCAL_SCRIPT"' } }
  );
  try {
    const findings = await detectPackageScripts({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.find((finding) => finding.kind === 'capability_echo.script_pipe_to_shell'), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('package scripts flag PowerShell remote download into iex', async () => {
  const fixture = await makeFixture(
    { name: 'app', scripts: {} },
    { name: 'app', scripts: { bootstrap: 'iwr https://install.example.com/bootstrap.ps1 | iex' } }
  );
  try {
    const findings = await detectPackageScripts({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.ok(findings.find((finding) => finding.kind === 'capability_echo.script_pipe_to_shell'));
  } finally {
    await fixture.cleanup();
  }
});
