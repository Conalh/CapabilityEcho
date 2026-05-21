import { appendFile, readFile } from 'node:fs/promises';
import { runCapabilityDiff } from './diff.js';
import { renderReport, type EchoRating } from './report.js';

const severityRank: Record<EchoRating, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export async function mainAction(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const repo = getInput(env, 'repo') || env.GITHUB_WORKSPACE || process.cwd();
  const event = await readEvent(env);
  const base = getInput(env, 'base') || getDefaultBase(env, event);
  const head = getInput(env, 'head') || getDefaultHead(env, event);
  const failOn = getInput(env, 'fail-on') || 'none';

  if (!base || !head) {
    writeError('CapabilityEcho needs base and head refs. Pass base/head inputs or run on pull_request with actions/checkout fetch-depth: 0.');
    return 2;
  }

  if (!isRating(failOn)) {
    writeError(`Invalid fail-on value '${failOn}'. Use none, low, medium, high, or critical.`);
    return 2;
  }

  const report = await runCapabilityDiff({ mode: 'git', repo, base, head });
  const markdown = renderReport(report, 'markdown');
  process.stdout.write(markdown);
  process.stdout.write(renderReport(report, 'github'));

  await appendIfSet(env.GITHUB_STEP_SUMMARY, markdown);
  await writeOutput(env, 'rating', report.rating);
  await writeOutput(env, 'finding-count', String(report.findingCount));
  await writeOutput(env, 'changed-file-count', String(report.changedFileCount));

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

  await appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
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
