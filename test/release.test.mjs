import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('npm package exposes the CLI without publish-time manifest repairs', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin?.capabilityecho, 'dist/index.js');
});

test('npm package contains only release runtime artifacts', async () => {
  const npmArgs = ['pack', '--dry-run', '--json'];
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs] : npmArgs;
  const { stdout } = await execFileAsync(command, args, {
    cwd: packageRoot,
    maxBuffer: 2 * 1024 * 1024
  });
  const pack = JSON.parse(stdout)[0];
  const paths = new Set(pack.files.map((entry) => entry.path));

  for (const required of [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'LICENSE',
    'action.yml',
    'dist/index.js',
    'dist/action.js',
    'dist/action-bundle/index.js',
    'dist/exceptions.js'
  ]) {
    assert.ok(paths.has(required), `expected ${required} in npm package`);
  }

  for (const forbiddenPrefix of ['src/', 'test/', 'benchmark/', '.github/', '.claude/']) {
    assert.equal(
      [...paths].some((path) => path.startsWith(forbiddenPrefix)),
      false,
      `npm package must not include ${forbiddenPrefix}`
    );
  }

  for (const forbidden of ['AGENTS.md', 'tsconfig.json', 'package-lock.json', '.gitattributes']) {
    assert.equal(paths.has(forbidden), false, `npm package must not include ${forbidden}`);
  }
});
