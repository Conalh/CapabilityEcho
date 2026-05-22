import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('CLI emits JSON capability drift report', async () => {
  const oldDir = join(testDir, 'fixtures', 'capability-drift', 'old');
  const newDir = join(testDir, 'fixtures', 'capability-drift', 'new');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'critical');
  assert.ok(report.findingCount >= 5);
  assert.ok(report.changedFileCount >= 3);
  assert.ok(report.capabilitySummary.length >= 4);
  assert.ok(report.findings.some((finding) => finding.kind === 'external_fetch_added'));
  assert.ok(report.findings.some((finding) => finding.kind === 'lifecycle_script_added'));
  assert.ok(report.findings.some((finding) => finding.kind === 'script_pipe_to_shell'));
  assert.ok(report.findings.some((finding) => finding.kind === 'workflow_permission_write'));
  assert.deepEqual(report.surfaceSummary, { source: 1, package: 3, workflow: 2, container: 0 });
  assert.deepEqual(report.severitySummary, { critical: 1, high: 2, medium: 3, low: 0 });
  assert.deepEqual(report.topRecommendations, [
    'Replace remote pipe-to-shell patterns with pinned, reviewable install steps.',
    'Use the narrowest permission scope required for this job.',
    'Review lifecycle scripts carefully; they run automatically on install.'
  ]);
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

test('CLI emits GitHub warning annotations', async () => {
  const oldDir = join(testDir, 'fixtures', 'capability-drift', 'old');
  const newDir = join(testDir, 'fixtures', 'capability-drift', 'new');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'github'],
    { cwd: packageRoot }
  );

  assert.match(stdout, /::warning file=src\/api\/sync\.ts,line=/);
  assert.match(stdout, /::warning file=package\.json,line=/);
  assert.match(stdout, /::warning file=\.github\/workflows\/ci\.yml,line=/);
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
  assert.equal(report.findingCount, 0);
});
