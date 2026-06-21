import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeOldNewFixture } from 'agent-gov-core/test-utils';
import { validateReport } from 'agent-gov-core';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

async function makeFixture(oldFiles, newFiles) {
  const fx = await makeOldNewFixture({ old: oldFiles, new: newFiles });
  return { oldRoot: fx.old, newRoot: fx.new, cleanup: fx.cleanup };
}

test('CLI emits JSON capability drift report', async () => {
  const oldDir = join(testDir, 'fixtures', 'capability-drift', 'old');
  const newDir = join(testDir, 'fixtures', 'capability-drift', 'new');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);
  const validation = validateReport(report);

  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(report.rating, 'critical');
  assert.ok(report.findings.length >= 5);
  assert.ok(report.data.changedFileCount >= 3);
  assert.ok(report.data.capabilitySummary.length >= 4);
  assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.external_fetch_added'));
  assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.lifecycle_script_added'));
  assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.script_pipe_to_shell'));
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.kind === 'capability_echo.workflow_permission_write' ||
        finding.kind === 'capability_echo.workflow_workflow_level_write_permission'
    ),
    'expected a workflow write-permission finding (per-line or structural)'
  );
  assert.deepEqual(report.data.surfaceSummary, { source: 1, package: 3, workflow: 2, container: 0 });
  assert.deepEqual(report.data.severitySummary, { critical: 1, high: 2, medium: 3, low: 0 });
  assert.deepEqual(report.data.topRecommendations, [
    'Replace remote pipe-to-shell patterns with pinned, reviewable install steps.',
    'Use the narrowest permission scope required for this job.',
    'Review lifecycle scripts carefully; they run automatically on install.'
  ]);

  const { stdout: repeatStdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'json'],
    { cwd: packageRoot }
  );
  const repeatReport = JSON.parse(repeatStdout);
  assert.deepEqual(
    repeatReport.findings.map((finding) => finding.fingerprint),
    report.findings.map((finding) => finding.fingerprint)
  );
});

test('CLI emits Markdown capability summary', async () => {
  const oldDir = join(testDir, 'fixtures', 'capability-drift', 'old');
  const newDir = join(testDir, 'fixtures', 'capability-drift', 'new');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'markdown'],
    { cwd: packageRoot }
  );

  assert.match(stdout, /# CapabilityEcho capability drift: CRITICAL/);
  assert.match(stdout, /## Top recommendations/);
  assert.match(stdout, /- Replace remote pipe-to-shell patterns with pinned, reviewable install steps\./);
  assert.match(stdout, /- Use the narrowest permission scope required for this job\./);
  assert.ok(stdout.indexOf('## Top recommendations') < stdout.indexOf('## Review summary'));
  assert.match(stdout, /Capability summary/);
  assert.match(stdout, /\| Surface \| Findings \|/);
  assert.match(stdout, /\| source code \| 1 \|/);
  assert.match(stdout, /\| package manifests \| 3 \|/);
  assert.match(stdout, /\| GitHub workflows \| 2 \|/);
  assert.match(stdout, /\| container builds \| 0 \|/);
  assert.match(stdout, /\| Critical \| 1 \|/);
  assert.match(stdout, /external network fetch calls/);
  assert.match(stdout, /postinstall/);
});

test('CLI emits severity-aware GitHub annotations', async () => {
  const oldDir = join(testDir, 'fixtures', 'capability-drift', 'old');
  const newDir = join(testDir, 'fixtures', 'capability-drift', 'new');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'github'],
    { cwd: packageRoot }
  );

  // medium/low stay ::warning; high/critical escalate to ::error to match
  // agent-gov-core's annotation contract.
  assert.match(stdout, /::warning file=src\/api\/sync\.ts,line=.*medium/);
  assert.match(stdout, /::error file=\.github\/workflows\/ci\.yml,line=7,title=CapabilityEcho high/);
  assert.match(stdout, /::error file=package\.json,line=6,title=CapabilityEcho high/);
  assert.match(stdout, /::error file=package\.json,line=6,title=CapabilityEcho critical/);
  assert.match(stdout, /::warning file=package\.json,line=6,title=CapabilityEcho medium/);
});

test('clean fixture returns rating none', async () => {
  const oldDir = join(testDir, 'fixtures', 'clean', 'old');
  const newDir = join(testDir, 'fixtures', 'clean', 'new');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'none');
  assert.equal(report.findings.length, 0);
});

test('CLI exits 0 by default when findings exceed nothing', async () => {
  const oldDir = join(testDir, 'fixtures', 'capability-drift', 'old');
  const newDir = join(testDir, 'fixtures', 'capability-drift', 'new');

  const result = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'json'],
    { cwd: packageRoot }
  );

  assert.equal(typeof result.stdout, 'string');
  assert.ok(result.stdout.length > 0);
});

test('CLI --fail-on returns non-zero when rating meets threshold', async () => {
  const oldDir = join(testDir, 'fixtures', 'capability-drift', 'old');
  const newDir = join(testDir, 'fixtures', 'capability-drift', 'new');

  const result = await execFileAsync(
    process.execPath,
    [
      'dist/index.js',
      'diff',
      '--old',
      oldDir,
      '--new',
      newDir,
      '--format',
      'json',
      '--fail-on',
      'HIGH'
    ],
    { cwd: packageRoot }
  ).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({
      code: typeof error === 'object' && error && 'code' in error ? error.code : undefined,
      stdout: typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '',
      stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
    })
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /rating critical meets fail-on threshold high/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.rating, 'critical');
});

test('CLI --fail-on returns 0 when rating below threshold', async () => {
  const oldDir = join(testDir, 'fixtures', 'clean', 'old');
  const newDir = join(testDir, 'fixtures', 'clean', 'new');

  const result = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'json', '--fail-on', 'high'],
    { cwd: packageRoot }
  );

  const report = JSON.parse(result.stdout);
  assert.equal(report.rating, 'none');
});

test('CLI rejects unknown --fail-on value', async () => {
  const oldDir = join(testDir, 'fixtures', 'clean', 'old');
  const newDir = join(testDir, 'fixtures', 'clean', 'new');

  const result = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--fail-on', 'bogus'],
    { cwd: packageRoot }
  ).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({
      code: typeof error === 'object' && error && 'code' in error ? error.code : undefined,
      stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
    })
  );

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Invalid --fail-on value/);
});

test('CLI applies active checked-in exceptions before fail-on', async () => {
  const exceptions = `${JSON.stringify({
    exceptions: [
      {
        kind: 'capability_echo.external_fetch_added',
        pathPrefix: 'src/',
        expires: '2099-01-01',
        reason: 'approved external API migration'
      }
    ]
  }, null, 2)}\n`;
  const fixture = await makeFixture(
    {
      'src/client.ts': 'export function ok() {\n  return true;\n}\n',
      '.capabilityecho-exceptions.json': exceptions
    },
    {
      'src/client.ts': "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n",
      '.capabilityecho-exceptions.json': exceptions
    }
  );

  try {
    const result = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--old', fixture.oldRoot, '--new', fixture.newRoot, '--format', 'json', '--fail-on', 'medium'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(result.stdout);

    assert.equal(report.rating, 'none');
    assert.equal(report.findings.length, 0);
    assert.equal(report.data.suppressedFindingCount, 1);
    assert.equal(report.data.expiredExceptionCount, 0);
    assert.equal(report.data.suppressedFindings.length, 1);
    assert.equal(report.data.suppressedFindings[0].kind, 'capability_echo.external_fetch_added');
    assert.match(report.data.suppressedFindings[0].fingerprint, /^[a-f0-9]{16}$/);
    assert.deepEqual(report.data.suppressedFindings[0].location, { file: 'src/client.ts', line: 2 });
    assert.equal(report.data.suppressedFindings[0].reason, 'approved external API migration');
    assert.equal(report.data.suppressedFindings[0].expires, '2099-01-01');
    assert.equal(report.data.analysisIncomplete, false);
  } finally {
    await fixture.cleanup();
  }
});

test('CLI does not let PR-added exceptions suppress their own findings', async () => {
  const fixture = await makeFixture(
    {
      'src/client.ts': 'export function ok() {\n  return true;\n}\n'
    },
    {
      'src/client.ts': "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n",
      '.capabilityecho-exceptions.json': `${JSON.stringify({
        exceptions: [
          {
            kind: 'capability_echo.external_fetch_added',
            pathPrefix: 'src/',
            expires: '2099-01-01',
            reason: 'untrusted PR-local exception'
          }
        ]
      }, null, 2)}\n`
    }
  );

  try {
    const result = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--old', fixture.oldRoot, '--new', fixture.newRoot, '--format', 'json', '--fail-on', 'medium'],
      { cwd: packageRoot }
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error) => ({
        code: typeof error === 'object' && error && 'code' in error ? error.code : undefined,
        stdout: typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '',
        stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
      })
    );
    const report = JSON.parse(result.stdout);

    assert.equal(result.code, 1);
    assert.equal(report.rating, 'high');
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.external_fetch_added'));
    assert.ok(report.findings.some((finding) => finding.kind === 'capability_echo.exception_policy_changed'));
    assert.equal(report.data.suppressedFindingCount, 0);
    assert.equal(report.data.suppressedFindings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('CLI keeps expired exceptions from lowering the original finding severity', async () => {
  const exceptions = `${JSON.stringify({
    exceptions: [
      {
        kind: 'capability_echo.external_fetch_added',
        pathPrefix: 'src/',
        expires: '2000-01-01',
        reason: 'temporary rollout exception'
      }
    ]
  }, null, 2)}\n`;
  const fixture = await makeFixture(
    {
      'src/client.ts': 'export function ok() {\n  return true;\n}\n',
      '.capabilityecho-exceptions.json': exceptions
    },
    {
      'src/client.ts': "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n",
      '.capabilityecho-exceptions.json': exceptions
    }
  );

  try {
    const result = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--old', fixture.oldRoot, '--new', fixture.newRoot, '--format', 'json', '--fail-on', 'medium'],
      { cwd: packageRoot }
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error) => ({
        code: typeof error === 'object' && error && 'code' in error ? error.code : undefined,
        stdout: typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '',
        stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
      })
    );
    const report = JSON.parse(result.stdout);
    const original = report.findings.find((finding) => finding.kind === 'capability_echo.external_fetch_added');
    const expired = report.findings.find((finding) => finding.kind === 'capability_echo.exception_expired');

    assert.equal(result.code, 1);
    assert.equal(report.rating, 'medium');
    assert.equal(report.findings.length, 2);
    assert.equal(original.severity, 'medium');
    assert.doesNotMatch(original.message, /^\[EXPIRED WHITELIST\]/);
    assert.equal(expired.severity, 'low');
    assert.equal(expired.data.exceptionReason, 'temporary rollout exception');
    assert.equal(report.data.suppressedFindingCount, 0);
    assert.equal(report.data.expiredExceptionCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('CLI keeps findings visible when trusted exception config is invalid', async () => {
  const exceptions = `${JSON.stringify({
    exceptions: [
      {
        kind: 'capability_echo.external_fetch_added',
        pathPrefix: 'src/'
      }
    ]
  }, null, 2)}\n`;
  const fixture = await makeFixture(
    {
      'src/client.ts': 'export function ok() {\n  return true;\n}\n',
      '.capabilityecho-exceptions.json': exceptions
    },
    {
      'src/client.ts': "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n",
      '.capabilityecho-exceptions.json': exceptions
    }
  );

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--old', fixture.oldRoot, '--new', fixture.newRoot, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(stdout);

    assert.equal(report.rating, 'medium');
    assert.equal(report.findings.length, 1);
    assert.equal(report.data.suppressedFindingCount, 0);
    assert.equal(report.data.analysisIncomplete, true);
    assert.ok(
      report.data.analysisDiagnostics.some((diagnostic) => diagnostic.kind === 'exception_config_error'),
      `expected exception_config_error diagnostic, got ${JSON.stringify(report.data.analysisDiagnostics)}`
    );
  } finally {
    await fixture.cleanup();
  }
});
