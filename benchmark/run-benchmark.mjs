#!/usr/bin/env node
// CapabilityEcho benchmark runner.
//
// Runs the built CLI against every labeled before/after fixture, then scores
// the verdicts against ground-truth labels: precision, recall, false-positive
// rate at each CI gate threshold, plus per-kind detection accuracy.
//
//   npm run build           # produce dist/ (the CLI under test)
//   node benchmark/run-benchmark.mjs
//
// Writes benchmark/RESULTS.md and prints the same report to stdout.
// Exit code is non-zero only if a fixture fails to run — the metrics
// themselves are reported, not gated.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cli = join(repoRoot, 'dist', 'index.js');
const actionBundle = join(repoRoot, 'dist', 'action-bundle', 'index.js');
const fixturesDir = process.env.CAPABILITYECHO_BENCHMARK_FIXTURES_DIR ?? join(here, 'fixtures');
const resultsPath = process.env.CAPABILITYECHO_BENCHMARK_RESULTS_PATH ?? join(here, 'RESULTS.md');
const skipRuntimeProbes = process.env.CAPABILITYECHO_BENCHMARK_SKIP_PROBES === '1';
const usingDefaultCorpus = fixturesDir === join(here, 'fixtures');

const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
// 'low' == "any finding at all" (rating rises to at least low on a single hit).
const THRESHOLDS = ['low', 'medium', 'high', 'critical'];
const DEFAULT_CORPUS_COUNTS = { total: 34, rogue: 20, benign: 14 };
const HIGH_GATE_MIN_RECALL = 0.85;

if (!existsSync(cli)) {
  process.stderr.write(`CLI not found at ${cli}\nRun "npm run build" first.\n`);
  process.exit(1);
}

function listCases(klass) {
  const dir = join(fixturesDir, klass);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const caseDir = join(dir, id);
      const label = JSON.parse(readFileSync(join(caseDir, 'label.json'), 'utf8'));
      return { caseDir, label };
    });
}

function runCli(beforeDir, afterDir) {
  const stdout = execFileSync('node', [cli, 'diff', '--old', beforeDir, '--new', afterDir, '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function runCliGit(repo, base, head) {
  const stdout = execFileSync('node', [cli, 'diff', '--repo', repo, '--base', base, '--head', head, '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

const results = [];
let runErrors = 0;

for (const klass of ['rogue', 'benign']) {
  for (const { caseDir, label } of listCases(klass)) {
    let report;
    try {
      report = runCli(join(caseDir, 'before'), join(caseDir, 'after'));
    } catch (err) {
      runErrors += 1;
      process.stderr.write(`ERROR running ${label.id}: ${err.message}\n`);
      continue;
    }
    const kinds = report.findings.map((f) => f.kind);
    const primaryKind = label.expectKinds[0];
    results.push({
      id: label.id,
      label: label.label,
      expectFlagged: label.expectFlagged,
      expectKinds: label.expectKinds,
      expectMinRating: label.expectMinRating,
      rating: report.rating,
      ratingRank: SEVERITY_RANK[report.rating],
      findingCount: report.findings.length,
      kinds,
      primaryMatched: primaryKind ? kinds.includes(primaryKind) : null,
      allKindsMatched: label.expectKinds.length ? label.expectKinds.every((k) => kinds.includes(k)) : null,
      minRatingMet: label.expectMinRating
        ? SEVERITY_RANK[report.rating] >= SEVERITY_RANK[label.expectMinRating]
        : null
    });
  }
}

function confusionAt(threshold) {
  const rank = SEVERITY_RANK[threshold];
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  for (const r of results) {
    const predictedPositive = r.ratingRank >= rank;
    if (r.expectFlagged) {
      if (predictedPositive) tp += 1;
      else fn += 1;
    } else {
      if (predictedPositive) fp += 1;
      else tn += 1;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = (tp + tn) / (tp + fp + fn + tn);
  return { threshold, tp, fp, fn, tn, precision, recall, fpr, f1, accuracy };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

const rogue = results.filter((r) => r.expectFlagged);
const benign = results.filter((r) => !r.expectFlagged);
const metrics = THRESHOLDS.map(confusionAt);
const detect = metrics.find((m) => m.threshold === 'low'); // any-finding detection
const gate = metrics.find((m) => m.threshold === 'high'); // typical CI gate

const primaryMatched = rogue.filter((r) => r.primaryMatched).length;
const allKindsMatched = rogue.filter((r) => r.allKindsMatched).length;
const minRatingMet = rogue.filter((r) => r.minRatingMet).length;

// ---- surprises: ground-truth disagreements worth eyeballing ----
const missedRogue = rogue.filter((r) => r.findingCount === 0);
const flaggedBenign = benign.filter((r) => r.findingCount > 0);
const missingPrimaryKinds = rogue.filter((r) => r.primaryMatched === false);
const missingExpectedKinds = rogue.filter((r) => r.allKindsMatched === false);
const minSeverityMisses = rogue.filter((r) => r.minRatingMet === false);
const runtimeProbes = skipRuntimeProbes ? [] : runRuntimeProbes();
const failedRuntimeProbes = runtimeProbes.filter((probe) => !probe.ok);
const qualityFailures = buildQualityFailures();

function buildQualityFailures() {
  const failures = [];

  if (runErrors > 0) {
    failures.push(`${runErrors} fixture(s) failed to run.`);
  }
  if (results.length === 0) {
    failures.push('No benchmark fixtures ran.');
  }
  if (usingDefaultCorpus) {
    if (results.length !== DEFAULT_CORPUS_COUNTS.total) {
      failures.push(`Default corpus case count changed: expected ${DEFAULT_CORPUS_COUNTS.total}, got ${results.length}.`);
    }
    if (rogue.length !== DEFAULT_CORPUS_COUNTS.rogue || benign.length !== DEFAULT_CORPUS_COUNTS.benign) {
      failures.push(
        `Default corpus class counts changed: expected ${DEFAULT_CORPUS_COUNTS.rogue} rogue/${DEFAULT_CORPUS_COUNTS.benign} benign, got ${rogue.length} rogue/${benign.length} benign.`
      );
    }
  }
  if (missedRogue.length > 0) {
    failures.push(`Missed rogue cases: ${missedRogue.map((r) => r.id).join(', ')}.`);
  }
  if (flaggedBenign.length > 0) {
    failures.push(`Flagged benign cases: ${flaggedBenign.map((r) => r.id).join(', ')}.`);
  }
  if (missingPrimaryKinds.length > 0) {
    failures.push(`Missing primary expected kinds: ${missingPrimaryKinds.map((r) => r.id).join(', ')}.`);
  }
  if (missingExpectedKinds.length > 0) {
    failures.push(`Missing one or more expected kinds: ${missingExpectedKinds.map((r) => r.id).join(', ')}.`);
  }
  if (minSeverityMisses.length > 0) {
    failures.push(`Expected minimum severity not reached: ${minSeverityMisses.map((r) => r.id).join(', ')}.`);
  }
  if (detect.recall < 1) {
    failures.push(`Detection recall regressed below 100.0%: ${pct(detect.recall)}.`);
  }
  if (detect.fpr > 0) {
    failures.push(`Detection false-positive rate exceeded 0.0%: ${pct(detect.fpr)}.`);
  }
  if (gate.recall < HIGH_GATE_MIN_RECALL) {
    failures.push(`High-gate recall regressed below ${pct(HIGH_GATE_MIN_RECALL)}: ${pct(gate.recall)}.`);
  }
  if (gate.fpr > 0) {
    failures.push(`High-gate false-positive rate exceeded 0.0%: ${pct(gate.fpr)}.`);
  }
  for (const probe of failedRuntimeProbes) {
    failures.push(`Runtime probe failed: ${probe.name}: ${probe.message}`);
  }

  return failures;
}

function runRuntimeProbes() {
  const probeRoot = mkdtempSync(join(tmpdir(), 'capabilityecho-benchmark-probes-'));
  try {
    const repo = createProbeRepo(probeRoot);
    const expectedFile = ' leading-fetch.ts';
    const probes = [];

    try {
      const gitReport = runCliGit(repo.path, repo.base, repo.head);
      const finding = gitReport.findings.find((f) => f.kind === 'capability_echo.external_fetch_added');
      probes.push({
        name: 'git mode hostile filename',
        ok: finding?.location?.file === expectedFile,
        message: finding
          ? `expected finding on ${JSON.stringify(expectedFile)}, got ${JSON.stringify(finding.location?.file)}`
          : 'expected external_fetch_added finding'
      });
    } catch (error) {
      probes.push({ name: 'git mode hostile filename', ok: false, message: errorMessage(error) });
    }

    try {
      const bundleReport = runActionBundleProbe(repo.path, repo.base, repo.head, probeRoot);
      const finding = bundleReport.findings.find((f) => f.kind === 'capability_echo.external_fetch_added');
      probes.push({
        name: 'candidate Action bundle',
        ok: bundleReport.rating === 'medium' && finding?.location?.file === expectedFile,
        message:
          bundleReport.rating === 'medium' && finding?.location?.file === expectedFile
            ? 'ok'
            : `expected medium external_fetch_added on ${JSON.stringify(expectedFile)}, got rating ${bundleReport.rating}`
      });
    } catch (error) {
      probes.push({ name: 'candidate Action bundle', ok: false, message: errorMessage(error) });
    }

    return probes;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function createProbeRepo(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'CapabilityEcho benchmark');
  git(repo, 'config', 'user.email', 'capabilityecho@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');

  writeFileSync(join(repo, 'package.json'), '{"name":"benchmark-probe","private":true}\n', 'utf8');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');

  writeFileSync(
    join(repo, ' leading-fetch.ts'),
    'export async function run() {\n  return fetch("https://api.example.com/probe");\n}\n',
    'utf8'
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'add hostile-path fetch');
  const head = git(repo, 'rev-parse', 'HEAD');

  return { path: repo, base, head };
}

function runActionBundleProbe(repo, base, head, root) {
  const outputPath = join(root, 'github-output.txt');
  const summaryPath = join(root, 'github-summary.md');
  execFileSync('node', [actionBundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      INPUT_REPO: repo,
      INPUT_BASE: base,
      INPUT_HEAD: head,
      INPUT_FAIL_ON: 'none',
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  const outputs = parseGithubOutputs(readFileSync(outputPath, 'utf8'));
  const reportJson = outputs.get('report-json');
  if (!reportJson) {
    throw new Error('bundled Action did not emit report-json');
  }
  return JSON.parse(reportJson);
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

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------- render ----------------------------
const lines = [];
const p = (s = '') => lines.push(s);

p('# CapabilityEcho benchmark results');
p('');
p('Generated by `node benchmark/run-benchmark.mjs` against the built `dist/` CLI.');
p('Corpus: labeled before/after PR snapshots under `benchmark/fixtures/`.');
p('');
p('> **This is a specification and regression suite, not an evaluation against');
p('> independent ground truth.** Detectors and fixtures share an author, so a perfect');
p('> score means the detectors behave to spec and keep doing so across changes — it');
p('> does *not* measure how well the tool catches what real agents or adversaries');
p('> produce. Each rogue fixture is a single textbook pattern; real PRs are messier.');
p('> See the README "Threat model and limits" for what the spec deliberately omits.');
p('');
p(`- Cases: **${results.length}** (${rogue.length} rogue, ${benign.length} benign)`);
p(`- Detection (any finding): recall **${pct(detect.recall)}**, false-positive rate **${pct(detect.fpr)}**, precision **${pct(detect.precision)}**`);
p(`- At a \`--fail-on=high\` CI gate: recall **${pct(gate.recall)}**, false-positive rate **${pct(gate.fpr)}**, precision **${pct(gate.precision)}**`);
p(`- Correct primary capability identified on **${primaryMatched}/${rogue.length}** rogue cases`);
p('');

p('## Confusion matrix by CI gate threshold');
p('');
p('A diff is predicted "drift" when its overall rating meets the threshold. `low` = any finding at all.');
p('');
p('| Gate (`--fail-on`) | TP | FP | FN | TN | Precision | Recall | FP rate | F1 | Accuracy |');
p('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const m of metrics) {
  p(
    `| ${m.threshold} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.fpr)} | ${pct(m.f1)} | ${pct(m.accuracy)} |`
  );
}
p('');

p('## Capability identification (rogue cases)');
p('');
p(`- Primary expected kind detected: **${primaryMatched}/${rogue.length}**`);
p(`- All expected kinds detected: **${allKindsMatched}/${rogue.length}**`);
p(`- Expected minimum severity reached: **${minRatingMet}/${rogue.length}**`);
p('');

p('## Quality gates');
p('');
if (qualityFailures.length === 0) {
  p('PASS. Benchmark metrics meet the committed regression gates.');
} else {
  p('FAIL. The benchmark must not be regenerated with these regressions:');
  for (const failure of qualityFailures) {
    p(`- ${failure}`);
  }
}
p('');

if (!skipRuntimeProbes) {
  p('## Runtime probes');
  p('');
  p('| Probe | Result | Detail |');
  p('| --- | --- | --- |');
  for (const probe of runtimeProbes) {
    p(`| ${probe.name} | ${probe.ok ? 'PASS' : 'FAIL'} | ${probe.message} |`);
  }
  p('');
}

if (missedRogue.length || flaggedBenign.length) {
  p('## Disagreements with ground truth');
  p('');
  if (missedRogue.length) {
    p(`**False negatives (rogue, no finding): ${missedRogue.length}**`);
    for (const r of missedRogue) p(`- ${r.id} — expected ${r.expectKinds.join(', ') || '(flag)'}`);
    p('');
  }
  if (flaggedBenign.length) {
    p(`**False positives (benign, flagged): ${flaggedBenign.length}**`);
    for (const r of flaggedBenign) p(`- ${r.id} — emitted ${r.kinds.join(', ')}`);
    p('');
  }
} else {
  p('## Disagreements with ground truth');
  p('');
  p('None. Every rogue case produced at least one finding; no benign case did.');
  p('');
}

p('## Per-case detail');
p('');
p('| Case | Label | Surface | Rating | Findings | Primary kind | Min severity |');
p('| --- | --- | --- | --- | ---: | :---: | :---: |');
for (const r of results) {
  const surface = JSON.parse(readFileSync(join(fixturesDir, r.expectFlagged ? 'rogue' : 'benign', r.id, 'label.json'), 'utf8')).surface;
  const primary = r.expectKinds.length === 0 ? '—' : r.primaryMatched ? 'yes' : 'NO';
  const minSev = r.expectMinRating ? (r.minRatingMet ? 'yes' : 'NO') : '—';
  p(`| ${r.id} | ${r.label} | ${surface} | ${r.rating} | ${r.findingCount} | ${primary} | ${minSev} |`);
}
p('');

const out = lines.join('\n');
process.stdout.write(out + '\n');
writeFileSync(resultsPath, out + '\n', 'utf8');

if (qualityFailures.length > 0) {
  process.stderr.write(`\nBenchmark quality gates failed:\n`);
  for (const failure of qualityFailures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}
