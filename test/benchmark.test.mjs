import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('benchmark fails when a rogue fixture is missed or emits the wrong kind', async () => {
  const fx = await makeBenchmarkFixture({
    rogue: [
      {
        id: 'R-missed',
        label: {
          description: 'Expected external fetch, but the diff is pure code.',
          surface: 'source',
          expectKinds: ['capability_echo.external_fetch_added'],
          expectMinRating: 'medium'
        },
        before: { 'src/app.js': 'export const value = 1;\n' },
        after: { 'src/app.js': 'export const value = 2;\n' }
      }
    ],
    benign: [
      {
        id: 'B-clean',
        label: { description: 'No capability drift.', surface: 'source', expectKinds: [] },
        before: { 'src/app.js': 'export const value = 1;\n' },
        after: { 'src/app.js': 'export const value = 1;\nexport const next = 2;\n' }
      }
    ]
  });

  try {
    const result = await runBenchmark(fx.fixturesDir, fx.resultsPath);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Benchmark quality gates failed/);
    assert.match(result.stderr, /R-missed/);
    const report = await readFile(fx.resultsPath, 'utf8');
    assert.match(report, /## Quality gates/);
    assert.match(report, /FAIL/);
  } finally {
    await fx.cleanup();
  }
});

test('benchmark fails when a benign fixture is flagged', async () => {
  const fx = await makeBenchmarkFixture({
    rogue: [
      {
        id: 'R-detected',
        label: {
          description: 'External fetch should be detected.',
          surface: 'source',
          expectKinds: ['capability_echo.external_fetch_added'],
          expectMinRating: 'medium'
        },
        before: { 'src/app.js': 'export const value = 1;\n' },
        after: { 'src/app.js': 'export async function run() {\n  return fetch("https://api.example.com");\n}\n' }
      }
    ],
    benign: [
      {
        id: 'B-false-positive',
        label: { description: 'Mislabeled benign external fetch.', surface: 'source', expectKinds: [] },
        before: { 'src/app.js': 'export const value = 1;\n' },
        after: { 'src/app.js': 'export async function run() {\n  return fetch("https://api.example.com");\n}\n' }
      }
    ]
  });

  try {
    const result = await runBenchmark(fx.fixturesDir, fx.resultsPath);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Benchmark quality gates failed/);
    assert.match(result.stderr, /B-false-positive/);
  } finally {
    await fx.cleanup();
  }
});

test('benchmark passes a valid corpus and reports runtime probes', async () => {
  const fx = await makeBenchmarkFixture({
    rogue: [
      {
        id: 'R-high',
        label: {
          description: 'Secret exfiltration should be detected at high severity.',
          surface: 'source',
          expectKinds: ['capability_echo.source_secret_exfil_pattern', 'capability_echo.external_fetch_added'],
          expectMinRating: 'high'
        },
        before: { 'src/app.js': 'export const value = 1;\n' },
        after: {
          'src/app.js':
            'export async function run() {\n  return fetch("https://api.example.com", { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });\n}\n'
        }
      }
    ],
    benign: [
      {
        id: 'B-clean',
        label: { description: 'No capability drift.', surface: 'source', expectKinds: [] },
        before: { 'src/app.js': 'export const value = 1;\n' },
        after: { 'src/app.js': 'export const value = 1;\nexport const next = 2;\n' }
      }
    ]
  });

  try {
    const result = await runBenchmark(fx.fixturesDir, fx.resultsPath, { skipProbes: false });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /## Runtime probes/);
    assert.match(result.stdout, /git mode hostile filename \| PASS/);
    assert.match(result.stdout, /candidate Action bundle \| PASS/);
    assert.match(await readFile(fx.resultsPath, 'utf8'), /PASS\. Benchmark metrics meet the committed regression gates\./);
  } finally {
    await fx.cleanup();
  }
});

test('benchmark workflow verifies fixture generator drift and candidate bundle probes', async () => {
  const workflow = await readFile(join(packageRoot, '.github/workflows/benchmark.yml'), 'utf8');

  assert.match(workflow, /node benchmark\/build-fixtures\.mjs --check/);
  assert.match(workflow, /npm run benchmark/);
});

async function runBenchmark(fixturesDir, resultsPath, { skipProbes = true } = {}) {
  return execFileAsync(process.execPath, ['benchmark/run-benchmark.mjs'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CAPABILITYECHO_BENCHMARK_FIXTURES_DIR: fixturesDir,
      CAPABILITYECHO_BENCHMARK_RESULTS_PATH: resultsPath,
      ...(skipProbes ? { CAPABILITYECHO_BENCHMARK_SKIP_PROBES: '1' } : {})
    },
    maxBuffer: 20 * 1024 * 1024
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({
      code: typeof error === 'object' && error && 'code' in error ? error.code : undefined,
      stdout: typeof error === 'object' && error && 'stdout' in error ? String(error.stdout) : '',
      stderr: typeof error === 'object' && error && 'stderr' in error ? String(error.stderr) : ''
    })
  );
}

async function makeBenchmarkFixture({ rogue, benign }) {
  const root = await mkdtemp(join(tmpdir(), 'capabilityecho-benchmark-'));
  const fixturesDir = join(root, 'fixtures');
  const resultsPath = join(root, 'RESULTS.md');

  for (const entry of rogue) {
    await writeCase(fixturesDir, 'rogue', entry, true);
  }
  for (const entry of benign) {
    await writeCase(fixturesDir, 'benign', entry, false);
  }

  return {
    fixturesDir,
    resultsPath,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function writeCase(fixturesDir, klass, entry, expectFlagged) {
  const caseDir = join(fixturesDir, klass, entry.id);
  await writeTree(join(caseDir, 'before'), entry.before);
  await writeTree(join(caseDir, 'after'), entry.after);
  await writeFile(
    join(caseDir, 'label.json'),
    `${JSON.stringify(
      {
        id: entry.id,
        label: klass,
        expectFlagged,
        ...entry.label
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function writeTree(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}
