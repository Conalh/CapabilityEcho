import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { runCapabilityDiff } from './diff.js';
import { GitDiffSetupError } from './git-diff.js';
import { renderReport, severityRank } from './report.js';
export async function mainAction(env = process.env) {
    const repo = getInput(env, 'repo') || env.GITHUB_WORKSPACE || process.cwd();
    const event = await readEvent(env);
    const base = getInput(env, 'base') || getDefaultBase(env, event);
    const head = getInput(env, 'head') || getDefaultHead(env, event);
    const failOnInput = getInput(env, 'fail-on') || 'none';
    const failOn = failOnInput.toLowerCase();
    const maxFindings = parseNonNegativeInt(getInput(env, 'max-findings'), 0);
    const maxOutputBytes = parseNonNegativeInt(getInput(env, 'max-output-bytes'), 0);
    const reportFile = getInput(env, 'report-file');
    if (maxFindings === undefined) {
        writeError(`Invalid max-findings value '${getInput(env, 'max-findings')}'. Use a non-negative integer.`);
        return 2;
    }
    if (maxOutputBytes === undefined) {
        writeError(`Invalid max-output-bytes value '${getInput(env, 'max-output-bytes')}'. Use a non-negative integer.`);
        return 2;
    }
    if (!base || !head) {
        writeError('CapabilityEcho needs base and head refs. Pass base/head inputs or run on pull_request with actions/checkout fetch-depth: 0.');
        return 2;
    }
    if (!isRating(failOn)) {
        writeError(`Invalid fail-on value '${failOnInput}'. Use none, low, medium, high, or critical.`);
        return 2;
    }
    let fullReport;
    try {
        fullReport = await runCapabilityDiff({ mode: 'git', repo, base, head });
    }
    catch (error) {
        if (error instanceof GitDiffSetupError) {
            writeError(`CapabilityEcho could not compare base '${error.base}' and head '${error.head}'. Ensure actions/checkout uses fetch-depth: 0, or pass refs that exist in the checkout through the \`base\` and \`head\` inputs.`);
            return 2;
        }
        throw error;
    }
    // Preserve the full report for the optional sidecar file before truncating
    // for the on-action outputs. The action's fail-on decision is still made
    // against the *full* rating so truncation can never lower it.
    const fullMarkdown = renderReport(fullReport, 'markdown');
    const fullJson = renderReport(fullReport, 'json');
    if (reportFile) {
        await writeReportSidecar(repo, reportFile, fullMarkdown, fullJson);
    }
    const report = truncateFindings(fullReport, maxFindings);
    const truncated = report.findingCount < fullReport.findingCount;
    const truncationNotice = truncated
        ? `\n> CapabilityEcho truncated this report to the top ${report.findingCount} of ${fullReport.findingCount} findings (max-findings=${maxFindings}). ${reportFile ? `Full report at \`${reportFile}\` and \`${reportFile}.json\`.` : 'Set `report-file` to capture the full report as a workflow artifact.'}\n`
        : '';
    const markdown = renderReport(report, 'markdown') + truncationNotice;
    const json = renderReport(report, 'json');
    const adoptionEvidence = JSON.stringify({
        rating: fullReport.rating,
        hasFindings: fullReport.findingCount > 0,
        findingCount: fullReport.findingCount,
        changedFileCount: fullReport.changedFileCount,
        surfaceSummary: fullReport.surfaceSummary,
        severitySummary: fullReport.severitySummary,
        capabilitySummary: fullReport.capabilitySummary,
        topRecommendations: fullReport.topRecommendations
    });
    process.stdout.write(markdown);
    process.stdout.write(renderReport(report, 'github'));
    await appendIfSet(env.GITHUB_STEP_SUMMARY, markdown);
    await writeOutput(env, 'rating', fullReport.rating);
    await writeOutput(env, 'has-findings', String(fullReport.findingCount > 0));
    await writeOutput(env, 'finding-count', String(fullReport.findingCount));
    await writeOutput(env, 'changed-file-count', String(fullReport.changedFileCount));
    await writeOutput(env, 'surface-summary', JSON.stringify(fullReport.surfaceSummary));
    await writeOutput(env, 'severity-summary', JSON.stringify(fullReport.severitySummary));
    await writeOutput(env, 'capability-summary', JSON.stringify(fullReport.capabilitySummary));
    await writeOutput(env, 'top-recommendations', JSON.stringify(fullReport.topRecommendations));
    await writeOutput(env, 'adoption-evidence', adoptionEvidence);
    await writeOutput(env, 'report-markdown', clampOutput(markdown, maxOutputBytes, reportFile));
    await writeOutput(env, 'report-json', clampOutput(json, maxOutputBytes, reportFile));
    if (severityRank[failOn] > 0 && severityRank[fullReport.rating] >= severityRank[failOn]) {
        writeError(`CapabilityEcho capability drift rating ${fullReport.rating} meets fail-on threshold ${failOn}.`);
        return 1;
    }
    return 0;
}
function parseNonNegativeInt(raw, fallback) {
    if (!raw) {
        return fallback;
    }
    if (!/^\d+$/.test(raw)) {
        return undefined;
    }
    return Number.parseInt(raw, 10);
}
function truncateFindings(report, maxFindings) {
    if (maxFindings <= 0 || report.findings.length <= maxFindings) {
        return report;
    }
    const ranked = [...report.findings]
        .map((finding, index) => ({ finding, index }))
        .sort((left, right) => {
        const delta = severityRank[right.finding.severity] - severityRank[left.finding.severity];
        return delta === 0 ? left.index - right.index : delta;
    })
        .slice(0, maxFindings)
        .sort((left, right) => left.index - right.index)
        .map((entry) => entry.finding);
    return {
        ...report,
        findingCount: ranked.length,
        surfaceSummary: countBySurface(ranked),
        severitySummary: countBySeverity(ranked),
        findings: ranked
    };
}
function countBySurface(findings) {
    return {
        source: findings.filter((finding) => finding.surface === 'source').length,
        package: findings.filter((finding) => finding.surface === 'package').length,
        workflow: findings.filter((finding) => finding.surface === 'workflow').length,
        container: findings.filter((finding) => finding.surface === 'container').length
    };
}
function countBySeverity(findings) {
    return {
        critical: findings.filter((finding) => finding.severity === 'critical').length,
        high: findings.filter((finding) => finding.severity === 'high').length,
        medium: findings.filter((finding) => finding.severity === 'medium').length,
        low: findings.filter((finding) => finding.severity === 'low').length
    };
}
function clampOutput(value, maxBytes, reportFile) {
    if (maxBytes <= 0 || Buffer.byteLength(value, 'utf8') <= maxBytes) {
        return value;
    }
    const reference = reportFile
        ? `Full report at \`${reportFile}\` and \`${reportFile}.json\`.`
        : 'Set `report-file` to capture the full report as a workflow artifact.';
    return `CapabilityEcho output suppressed: payload exceeded max-output-bytes=${maxBytes}. ${reference}\n`;
}
async function writeReportSidecar(repo, reportFile, markdown, json) {
    const absolute = isAbsolute(reportFile) ? reportFile : resolve(repo, reportFile);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, markdown, 'utf8');
    await writeFile(`${absolute}.json`, json, 'utf8');
}
function getInput(env, name) {
    const primary = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
    const normalized = env[`INPUT_${name.replace(/[- ]/g, '_').toUpperCase()}`];
    return (primary || normalized || '').trim();
}
async function readEvent(env) {
    if (!env.GITHUB_EVENT_PATH) {
        return {};
    }
    try {
        const content = await readFile(env.GITHUB_EVENT_PATH, 'utf8');
        const parsed = JSON.parse(content);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function getDefaultBase(env, event) {
    const pullRequest = event.pull_request;
    if (isRecord(pullRequest) && isRecord(pullRequest.base) && typeof pullRequest.base.sha === 'string') {
        return pullRequest.base.sha;
    }
    if (typeof event.before === 'string') {
        return event.before;
    }
    return env.DEFAULT_BASE || '';
}
function getDefaultHead(env, event) {
    const pullRequest = event.pull_request;
    if (isRecord(pullRequest) && isRecord(pullRequest.head) && typeof pullRequest.head.sha === 'string') {
        return pullRequest.head.sha;
    }
    if (typeof event.after === 'string') {
        return event.after;
    }
    return env.DEFAULT_HEAD || env.GITHUB_SHA || '';
}
async function writeOutput(env, name, value) {
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
function outputDelimiter(name, value) {
    const normalizedName = name.replace(/[^A-Za-z0-9_]+/g, '_');
    let delimiter = `capabilityecho_${normalizedName}_EOF`;
    let suffix = 1;
    while (value.includes(delimiter)) {
        delimiter = `capabilityecho_${normalizedName}_EOF_${suffix}`;
        suffix += 1;
    }
    return delimiter;
}
async function appendIfSet(path, content) {
    if (!path) {
        return;
    }
    await appendFile(path, content, 'utf8');
}
function writeError(message) {
    process.stdout.write(`::error::${escapeMessage(message)}\n`);
}
function escapeMessage(value) {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
function isRating(value) {
    return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
if (process.argv[1]?.endsWith('action.js')) {
    process.exitCode = await mainAction();
}
