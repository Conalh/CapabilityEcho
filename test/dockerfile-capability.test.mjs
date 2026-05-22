import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDockerfileCapability } from '../dist/detectors/dockerfile-capability.js';
import { isScannable, surfaceForPath } from '../dist/paths.js';

function line(file, content, lineNumber = 1) {
  return { file, line: lineNumber, content };
}

test('dockerfile: Dockerfiles are scannable container surfaces', () => {
  assert.equal(isScannable('Dockerfile'), true);
  assert.equal(surfaceForPath('Dockerfile'), 'container');
  assert.equal(surfaceForPath('docker/Dockerfile.release'), 'container');
});

test('dockerfile: remote ADD is high capability drift', () => {
  const findings = detectDockerfileCapability([
    line('Dockerfile', 'ADD https://install.example.com/agent /usr/local/bin/agent')
  ]);

  const finding = findings.find((item) => item.kind === 'capability_echo.dockerfile_remote_add');
  assert.ok(finding);
  assert.equal(finding.surface, 'container');
  assert.equal(finding.severity, 'high');
});

test('dockerfile: curl piped to shell is critical capability drift', () => {
  const findings = detectDockerfileCapability([
    line('docker/Dockerfile.release', 'RUN curl https://install.example.com/setup.sh | bash')
  ]);

  const finding = findings.find((item) => item.kind === 'capability_echo.dockerfile_pipe_to_shell');
  assert.ok(finding);
  assert.equal(finding.surface, 'container');
  assert.equal(finding.severity, 'critical');
});

test('dockerfile: comments and non-Dockerfiles are ignored', () => {
  const findings = detectDockerfileCapability([
    line('Dockerfile', '# RUN curl https://install.example.com/setup.sh | bash'),
    line('scripts/build.sh', 'ADD https://install.example.com/agent /usr/local/bin/agent')
  ]);

  assert.equal(findings.length, 0);
});
