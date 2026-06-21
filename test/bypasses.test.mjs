import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

async function runBypassDiff(name) {
  const oldDir = join(testDir, 'fixtures', 'bypasses', name, 'old');
  const newDir = join(testDir, 'fixtures', 'bypasses', name, 'new');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'diff', '--old', oldDir, '--new', newDir, '--format', 'json'],
    { cwd: packageRoot }
  );
  return JSON.parse(stdout);
}

test('bypass: JS destructured env secret flags exfil on later external request', async () => {
  const report = await runBypassDiff('destructuring-env-js');
  const exfil = report.findings.find(
    (finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern'
  );
  assert.ok(exfil, 'expected source_secret_exfil_pattern finding');
  assert.match(exfil.location.file, /sync\.ts$/);
});

test('bypass: Python aliased getenv flags exfil on later external request', async () => {
  const report = await runBypassDiff('aliased-getenv-py');
  const exfil = report.findings.find(
    (finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern'
  );
  assert.ok(exfil, 'expected source_secret_exfil_pattern finding');
  assert.match(exfil.location.file, /agent\.py$/);
});

test('bypass: workflow PR-head via clone_url and refs/pull/N/merge under pull_request_target', async () => {
  const report = await runBypassDiff('pr-head-clone-url');
  const headFindings = report.findings.filter(
    (finding) => finding.kind === 'capability_echo.workflow_pr_head_checkout_on_target'
  );
  assert.ok(headFindings.length >= 2, `expected at least 2 PR-head findings, got ${headFindings.length}`);
  const filesAndLines = new Set(headFindings.map((finding) => `${finding.location.file}:${finding.location.line}`));
  assert.ok(filesAndLines.has('.github/workflows/pr-audit.yml:13'), 'expected clone_url line to be flagged');
  assert.ok(filesAndLines.has('.github/workflows/pr-audit.yml:15'), 'expected refs/pull/N/merge line to be flagged');
});
