import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('action.yml exposes capability drift outputs', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');
  assert.match(action, /name: CapabilityEcho/);
  assert.match(action, /has-findings/);
  assert.match(action, /changed-file-count/);
  assert.match(action, /surface-summary/);
  assert.match(action, /severity-summary/);
  assert.match(action, /capability-summary/);
  assert.match(action, /top-recommendations/);
  assert.match(action, /adoption-evidence/);
  assert.match(action, /report-markdown/);
  assert.match(action, /report-json/);
  assert.match(action, /fail-on/);
});

test('action.yml runs the checked-in JavaScript action without installing PR-local scripts first', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  assert.match(action, /runs:\s*\r?\n\s+using: node24\r?\n\s+main: dist\/action-bundle\/index\.js/);
  assert.doesNotMatch(action, /using: composite/);
  assert.doesNotMatch(action, /npm ci/);
  assert.doesNotMatch(action, /npm run build/);
});

test('compiled action runtime is not ignored by git', async () => {
  const ignored = await execFileAsync('git', ['-C', packageRoot, 'check-ignore', 'dist/action.js']).then(
    () => true,
    (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) {
        return false;
      }

      throw error;
    }
  );

  assert.equal(ignored, false);
});

test('self-dogfood workflow uses the trusted repository action instead of PR-local action code', async () => {
  const workflow = await readFile(join(packageRoot, '.github/workflows/capabilityecho.yml'), 'utf8');
  assert.match(workflow, /uses: Conalh\/CapabilityEcho@main/);
  assert.doesNotMatch(workflow, /uses: \.\//);
  assert.match(workflow, /fetch-depth: 0/);
});

test('JavaScript action entrypoint emits outputs, summary, and GitHub annotations', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-action-'));
  const outputPath = join(repo, 'github-output.txt');
  const summaryPath = join(repo, 'github-summary.md');

  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'action-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      source: "export function ok() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base app');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'action-fixture',
        private: true,
        scripts: {
          test: 'vitest',
          postinstall: 'curl https://install.example.com/setup.sh | bash'
        }
      },
      source: "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'add capability drift');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const { stdout } = await execFileAsync(process.execPath, ['dist/action.js'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        INPUT_REPO: repo,
        INPUT_BASE: base,
        INPUT_HEAD: head,
        'INPUT_FAIL-ON': 'none',
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath
      }
    });

    const outputs = await readFile(outputPath, 'utf8');
    const summary = await readFile(summaryPath, 'utf8');
    const parsedOutputs = parseGithubOutputs(outputs);

    assert.match(outputs, /^rating=critical$/m);
    assert.match(outputs, /^has-findings=true$/m);
    assert.match(outputs, /^finding-count=4$/m);
    assert.match(outputs, /^changed-file-count=2$/m);
    assert.match(outputs, /^surface-summary=\{"source":1,"package":3,"workflow":0,"container":0\}$/m);
    assert.match(outputs, /^severity-summary=\{"critical":1,"high":1,"medium":2,"low":0\}$/m);
    assert.match(
      outputs,
      /^capability-summary=\["external network fetch calls","npm lifecycle scripts","pipe-to-shell install scripts","network or publish npm scripts"\]$/m
    );
    assert.match(
      outputs,
      /^top-recommendations=\["Replace remote pipe-to-shell patterns with pinned, reviewable install steps.","Review lifecycle scripts carefully; they run automatically on install.","Review the endpoint, data sent, and whether the request belongs in this change\."\]$/m
    );
    assert.match(outputs, /^adoption-evidence=/m);
    assert.equal(parsedOutputs.get('report-markdown'), summary);
    assert.match(parsedOutputs.get('report-markdown') ?? '', /# CapabilityEcho capability drift: CRITICAL/);
    const adoptionEvidence = JSON.parse(parsedOutputs.get('adoption-evidence') ?? '{}');
    assert.deepEqual(Object.keys(adoptionEvidence), [
      'rating',
      'hasFindings',
      'findingCount',
      'changedFileCount',
      'surfaceSummary',
      'severitySummary',
      'capabilitySummary',
      'topRecommendations'
    ]);
    assert.equal(adoptionEvidence.rating, 'critical');
    assert.equal(adoptionEvidence.hasFindings, true);
    assert.deepEqual(adoptionEvidence.surfaceSummary, { source: 1, package: 3, workflow: 0, container: 0 });
    assert.equal('findings' in adoptionEvidence, false);
    const jsonReport = JSON.parse(parsedOutputs.get('report-json') ?? '{}');
    assert.equal(jsonReport.rating, 'critical');
    assert.equal(jsonReport.findingCount, 4);
    assert.deepEqual(jsonReport.surfaceSummary, { source: 1, package: 3, workflow: 0, container: 0 });
    assert.ok(jsonReport.findings.some((finding) => finding.kind === 'capability_echo.external_fetch_added'));
    assert.match(summary, /# CapabilityEcho capability drift: CRITICAL/);
    assert.match(summary, /## Top recommendations/);
    assert.match(stdout, /::warning file=src\/client\.ts,line=2/);
    assert.match(stdout, /::warning file=package\.json,line=/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('JavaScript action emits has-findings false for clean changed diffs', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-clean-action-'));
  const outputPath = join(repo, 'github-output.txt');
  const summaryPath = join(repo, 'github-summary.md');

  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'clean-action-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      source: "export function label() {\n  return 'base';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base app');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'clean-action-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      source: "export function label() {\n  return 'renamed';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'safe source rename');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    await execFileAsync(process.execPath, ['dist/action.js'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        INPUT_REPO: repo,
        INPUT_BASE: base,
        INPUT_HEAD: head,
        INPUT_FAIL_ON: 'none',
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath
      }
    });

    const outputs = await readFile(outputPath, 'utf8');
    const summary = await readFile(summaryPath, 'utf8');

    assert.match(outputs, /^rating=none$/m);
    assert.match(outputs, /^has-findings=false$/m);
    assert.match(outputs, /^finding-count=0$/m);
    assert.match(outputs, /^changed-file-count=1$/m);
    assert.match(outputs, /^capability-summary=\[\]$/m);
    assert.match(summary, /No code or workflow capability drift findings\./);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('JavaScript action derives base and head from pull_request event payload', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-pr-event-'));
  const outputPath = join(repo, 'github-output.txt');
  const summaryPath = join(repo, 'github-summary.md');
  const eventPath = join(repo, 'event.json');

  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'event-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      source: "export function ok() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base app');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'event-fixture',
        private: true,
        scripts: {
          test: 'vitest',
          postinstall: 'curl https://install.example.com/setup.sh | bash'
        }
      },
      source: "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'add capability drift');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeFile(
      eventPath,
      `${JSON.stringify({
        pull_request: {
          base: { sha: base },
          head: { sha: head }
        }
      })}\n`,
      'utf8'
    );

    const { stdout } = await execFileAsync(process.execPath, ['dist/action.js'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        INPUT_REPO: repo,
        INPUT_FAIL_ON: 'none',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath
      }
    });

    const outputs = await readFile(outputPath, 'utf8');
    const summary = await readFile(summaryPath, 'utf8');

    assert.match(outputs, /^rating=critical$/m);
    assert.match(outputs, /^finding-count=4$/m);
    assert.match(outputs, /^changed-file-count=2$/m);
    assert.match(summary, /# CapabilityEcho capability drift: CRITICAL/);
    assert.match(stdout, /::warning file=src\/client\.ts,line=2/);
    assert.doesNotMatch(stdout, /CapabilityEcho needs base and head refs/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('JavaScript action normalizes fail-on input before enforcing threshold', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-fail-on-'));
  const outputPath = join(repo, 'github-output.txt');
  const summaryPath = join(repo, 'github-summary.md');

  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');

    await writeProject(repo, {
      packageJson: {
        name: 'fail-on-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      source: "export function ok() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base app');
    const base = await gitStdout(repo, 'rev-parse', 'HEAD');

    await writeProject(repo, {
      packageJson: {
        name: 'fail-on-fixture',
        private: true,
        scripts: {
          test: 'vitest',
          postinstall: 'curl https://install.example.com/setup.sh | bash'
        }
      },
      source: "export async function sync() {\n  await fetch('https://api.example.com/v1/events');\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'add capability drift');
    const head = await gitStdout(repo, 'rev-parse', 'HEAD');

    const result = await execFileAsync(process.execPath, ['dist/action.js'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        INPUT_REPO: repo,
        INPUT_BASE: base,
        INPUT_HEAD: head,
        INPUT_FAIL_ON: 'HIGH',
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath
      }
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error) => ({
        code: typeof error === 'object' && error && 'code' in error ? error.code : undefined,
        stdout: typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '',
        stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
      })
    );

    assert.equal(result.code, 1);
    assert.match(result.stdout, /# CapabilityEcho capability drift: CRITICAL/);
    assert.match(result.stdout, /::error::CapabilityEcho capability drift rating critical meets fail-on threshold high\./);

    const outputs = await readFile(outputPath, 'utf8');
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(outputs, /^rating=critical$/m);
    assert.match(outputs, /^top-recommendations=/m);
    assert.match(summary, /## Top recommendations/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('JavaScript action reports missing git refs without a stack trace', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'capabilityecho-missing-ref-'));

  try {
    await execGit(repo, 'init', '-b', 'main');
    await execGit(repo, 'config', 'user.name', 'CapabilityEcho Test');
    await execGit(repo, 'config', 'user.email', 'capabilityecho@example.invalid');
    await writeProject(repo, {
      packageJson: {
        name: 'missing-ref-fixture',
        private: true,
        scripts: { test: 'vitest' }
      },
      source: "export function ok() {\n  return 'ok';\n}\n"
    });
    await execGit(repo, 'add', '.');
    await execGit(repo, 'commit', '-m', 'base app');

    const result = await execFileAsync(process.execPath, ['dist/action.js'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        INPUT_REPO: repo,
        INPUT_BASE: 'missing-base-ref',
        INPUT_HEAD: 'missing-head-ref',
        INPUT_FAIL_ON: 'none'
      }
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error) => ({
        code: typeof error === 'object' && error && 'code' in error ? error.code : undefined,
        stdout: typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '',
        stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
      })
    );

    assert.equal(result.code, 2);
    assert.match(result.stdout, /::error::CapabilityEcho could not compare base 'missing-base-ref' and head 'missing-head-ref'/);
    assert.match(result.stdout, /fetch-depth: 0/);
    assert.match(result.stdout, /`base` and `head` inputs/);
    assert.doesNotMatch(result.stdout + result.stderr, /at mainAction|node:internal|rev-parse/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

async function writeProject(repo, { packageJson, source }) {
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  await writeFile(join(repo, 'src/client.ts'), source, 'utf8');
}

async function execGit(cwd, ...args) {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function gitStdout(cwd, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

function parseGithubOutputs(content) {
  const outputs = new Map();
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    const heredocMatch = line.match(/^([^=<>]+)<<(.+)$/);
    if (heredocMatch) {
      const [, name, delimiter] = heredocMatch;
      const valueLines = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        valueLines.push(lines[index]);
        index += 1;
      }
      outputs.set(name, `${valueLines.join('\n')}\n`);
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex > 0) {
      outputs.set(line.slice(0, equalsIndex), line.slice(equalsIndex + 1));
    }
  }

  return outputs;
}
