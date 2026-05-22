import { appendFile, readFile } from 'node:fs/promises';
import { runCapabilityDiff } from './diff.js';
import { GitDiffSetupError } from './git-diff.js';
import { renderReport, severityRank, type EchoRating } from './report.js';

export async function mainAction(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const repo = getInput(env, 'repo') || env.GITHUB_WORKSPACE || process.cwd();
  const event = await readEvent(env);
  const base = getInput(env, 'base') || getDefaultBase(env, event);
  const head = getInput(env, 'head') || getDefaultHead(env, event);
  const failOnInput = getInput(env, 'fail-on') || 'none';
  const failOn = failOnInput.toLowerCase();

  if (!base || !head) {
    writeError('CapabilityEcho needs base and head refs. Pass base/head inputs or run on pull_request with actions/checkout fetch-depth: 0.');
    return 2;
  }

  if (!isRating(failOn)) {
    writeError(`Invalid fail-on value '${failOnInput}'. Use none, low, medium, high, or critical.`);
    return 2;
  }

  let report;
  try {
    report = await runCapabilityDiff({ mode: 'git', repo, base, head });
  } catch (error) {
    if (error instanceof GitDiffSetupError) {
      writeError(
        `CapabilityEcho could not compare base '${error.base}' and head '${error.head}'. Ensure actions/checkout uses fetch-depth: 0, or pass refs that exist in the checkout through the \`base\` and \`head\` inputs.`
      );
      return 2;
    }

    throw error;
  }

  const markdown = renderReport(report, 'markdown');
  const json = renderReport(report, 'json');
  const adoptionEvidence = JSON.stringify({
    rating: report.rating,
    hasFindings: report.findingCount > 0,
    findingCount: report.findingCount,
    changedFileCount: report.changedFileCount,
    surfaceSummary: report.surfaceSummary,
    severitySummary: report.severitySummary,
    capabilitySummary: report.capabilitySummary,
    topRecommendations: report.topRecommendations
  });
  process.stdout.write(markdown);
  process.stdout.write(renderReport(report, 'github'));

  await appendIfSet(env.GITHUB_STEP_SUMMARY, markdown);
  await writeOutput(env, 'rating', report.rating);
  await writeOutput(env, 'has-findings', String(report.findingCount > 0));
  await writeOutput(env, 'finding-count', String(report.findingCount));
  await writeOutput(env, 'changed-file-count', String(report.changedFileCount));
  await writeOutput(env, 'surface-summary', JSON.stringify(report.surfaceSummary));
  await writeOutput(env, 'severity-summary', JSON.stringify(report.severitySummary));
  await writeOutput(env, 'capability-summary', JSON.stringify(report.capabilitySummary));
  await writeOutput(env, 'top-recommendations', JSON.stringify(report.topRecommendations));
  await writeOutput(env, 'adoption-evidence', adoptionEvidence);
  await writeOutput(env, 'report-markdown', markdown);
  await writeOutput(env, 'report-json', json);

  if (severityRank[failOn] > 0 && severityRank[report.rating] >= severityRank[failOn]) {
    writeError(`CapabilityEcho capability drift rating ${report.rating} meets fail-on threshold ${failOn}.`);
    return 1;
  }

  return 0;
}

function getInput(env: NodeJS.ProcessEnv, name: string): string {
  const primary = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  const normalized = env[`INPUT_${name.replace(/[- ]/g, '_').toUpperCase()}`];
  return (primary || normalized || '').trim();
}

async function readEvent(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  if (!env.GITHUB_EVENT_PATH) {
    return {};
  }

  try {
    const content = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getDefaultBase(env: NodeJS.ProcessEnv, event: Record<string, unknown>): string {
  const pullRequest = event.pull_request;
  if (isRecord(pullRequest) && isRecord(pullRequest.base) && typeof pullRequest.base.sha === 'string') {
    return pullRequest.base.sha;
  }

  if (typeof event.before === 'string') {
    return event.before;
  }

  return env.DEFAULT_BASE || '';
}

function getDefaultHead(env: NodeJS.ProcessEnv, event: Record<string, unknown>): string {
  const pullRequest = event.pull_request;
  if (isRecord(pullRequest) && isRecord(pullRequest.head) && typeof pullRequest.head.sha === 'string') {
    return pullRequest.head.sha;
  }

  if (typeof event.after === 'string') {
    return event.after;
  }

  return env.DEFAULT_HEAD || env.GITHUB_SHA || '';
}

async function writeOutput(env: NodeJS.ProcessEnv, name: string, value: string): Promise<void> {
  if (!env.GITHUB_OUTPUT) {
    return;
  }

  if (value.includes('\n') || value.includes('\r')) {
    const delimiter = outputDelimiter(name, value);
    const normalizedValue = value.endsWith('\n') ? value : `${value}\n`;
    await appendFile(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${normalizedValue}${delimiter}\n`, 'utf8');
    return;
  }

  await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

function outputDelimiter(name: string, value: string): string {
  const normalizedName = name.replace(/[^A-Za-z0-9_]+/g, '_');
  let delimiter = `capabilityecho_${normalizedName}_EOF`;
  let suffix = 1;

  while (value.includes(delimiter)) {
    delimiter = `capabilityecho_${normalizedName}_EOF_${suffix}`;
    suffix += 1;
  }

  return delimiter;
}

async function appendIfSet(path: string | undefined, content: string): Promise<void> {
  if (!path) {
    return;
  }

  await appendFile(path, content, 'utf8');
}

function writeError(message: string): void {
  process.stdout.write(`::error::${escapeMessage(message)}\n`);
}

function escapeMessage(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function isRating(value: string): value is EchoRating {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (process.argv[1]?.endsWith('action.js')) {
  process.exitCode = await mainAction();
}
