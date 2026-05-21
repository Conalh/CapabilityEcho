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
  assert.match(stdout, /Capability summary/);
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
