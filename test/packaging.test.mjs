import test from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('package.json declares the metadata fields publishers expect', async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files allowlist required so we never publish src/test/.github');
  assert.ok(pkg.repository && typeof pkg.repository.url === 'string');
  assert.ok(pkg.bugs && typeof pkg.bugs.url === 'string');
  assert.ok(typeof pkg.homepage === 'string');
  assert.ok(pkg.exports && typeof pkg.exports === 'object');
  assert.ok(pkg.engines && typeof pkg.engines.node === 'string');
});

test('npm pack --dry-run excludes src, tests, fixtures, and .github', async () => {
  // `exec` (not `execFile`) so npm.cmd on Windows resolves through the shell.
  const { stdout: jsonOut } = await execAsync('npm pack --dry-run --json', {
    cwd: packageRoot,
    maxBuffer: 10 * 1024 * 1024
  });
  const meta = JSON.parse(jsonOut)[0];
  const includedPaths = meta.files.map((entry) => entry.path.replace(/\\/g, '/'));

  for (const forbiddenPrefix of ['src/', 'test/', 'test/fixtures/', '.github/', 'tsconfig.json']) {
    const offenders = includedPaths.filter((p) => p === forbiddenPrefix || p.startsWith(forbiddenPrefix));
    assert.equal(
      offenders.length,
      0,
      `tarball should not include ${forbiddenPrefix}; got: ${offenders.join(', ')}`
    );
  }

  assert.ok(includedPaths.some((p) => p === 'dist/index.js'), 'CLI entrypoint must ship');
  assert.ok(includedPaths.some((p) => p === 'dist/action-bundle/index.js'), 'Action bundle must ship');
  assert.ok(includedPaths.some((p) => p === 'README.md'));
  assert.ok(includedPaths.some((p) => p === 'LICENSE'));
});
