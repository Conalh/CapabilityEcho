import test from 'node:test';
import assert from 'node:assert/strict';
import { detectShellCapability } from '../dist/detectors/shell-capability.js';
import { isScannable } from '../dist/paths.js';

function line(file, content, lineNumber = 1) {
  return { file, line: lineNumber, content };
}

test('shell: curl piped to bash is critical capability drift', () => {
  const findings = detectShellCapability([
    line('scripts/bootstrap.sh', 'curl https://install.example.com/agent.sh | bash')
  ]);

  const finding = findings.find((item) => item.kind === 'capability_echo.shell_pipe_to_shell');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.surface, 'source');
});

test('shell: script files are scannable source surfaces', () => {
  assert.equal(isScannable('scripts/bootstrap.sh'), true);
  assert.equal(isScannable('tools/install.ps1'), true);
});

test('shell: literal external download is medium capability drift', () => {
  const findings = detectShellCapability([
    line('scripts/fetch-model.sh', 'wget https://models.example.com/latest.bin -O model.bin')
  ]);

  const finding = findings.find((item) => item.kind === 'capability_echo.shell_external_download');
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
});

test('shell: comment lines and non-shell files are ignored', () => {
  const findings = detectShellCapability([
    line('scripts/bootstrap.sh', '# curl https://install.example.com/agent.sh | bash'),
    line('src/client.ts', 'const cmd = "curl https://example.com"')
  ]);

  assert.equal(findings.length, 0);
});
