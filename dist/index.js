#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCapabilityDiff } from './diff.js';
import { renderReport, severityRank } from './report.js';
export async function main(argv = process.argv.slice(2)) {
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
        process.stdout.write(`${packageVersion()}\n`);
        return 0;
    }
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${usage()}\n`);
        return 0;
    }
    if (argv[0] === 'diff') {
        return runDiffCommand(argv.slice(1));
    }
    process.stderr.write(`Unknown command: ${argv[0]}\n`);
    return 2;
}
async function runDiffCommand(argv) {
    const parsed = parseDiffArgs(argv);
    if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n${usage()}\n`);
        return 2;
    }
    const report = parsed.mode === 'directories'
        ? await runCapabilityDiff({
            mode: 'directories',
            oldRoot: parsed.oldRoot,
            newRoot: parsed.newRoot,
            exceptionsFile: parsed.exceptionsFile
        })
        : await runCapabilityDiff({
            mode: 'git',
            repo: parsed.repo,
            base: parsed.base,
            head: parsed.head,
            exceptionsFile: parsed.exceptionsFile
        });
    process.stdout.write(renderReport(report, parsed.format));
    if (severityRank[parsed.failOn] > 0 && severityRank[report.rating] >= severityRank[parsed.failOn]) {
        process.stderr.write(`CapabilityEcho capability drift rating ${report.rating} meets fail-on threshold ${parsed.failOn}.\n`);
        return 1;
    }
    return 0;
}
function parseDiffArgs(argv) {
    let oldRoot;
    let newRoot;
    let base;
    let head;
    let repo = process.cwd();
    let format = 'text';
    let failOn = 'none';
    let exceptionsFile;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (arg === '--old') {
            oldRoot = value;
            index += 1;
        }
        else if (arg === '--new') {
            newRoot = value;
            index += 1;
        }
        else if (arg === '--repo') {
            repo = value;
            index += 1;
        }
        else if (arg === '--base') {
            base = value;
            index += 1;
        }
        else if (arg === '--head') {
            head = value;
            index += 1;
        }
        else if (arg === '--exceptions') {
            if (!value) {
                return { ok: false, error: 'Missing required --exceptions <path> argument.' };
            }
            exceptionsFile = value;
            index += 1;
        }
        else if (arg === '--format') {
            if (!isReportFormat(value)) {
                return { ok: false, error: `Invalid format: ${value ?? ''}` };
            }
            format = value;
            index += 1;
        }
        else if (arg === '--fail-on') {
            const normalized = (value ?? '').toLowerCase();
            if (!isRating(normalized)) {
                return { ok: false, error: `Invalid --fail-on value: ${value ?? ''}. Use none, low, medium, high, or critical.` };
            }
            failOn = normalized;
            index += 1;
        }
        else {
            return { ok: false, error: `Unknown argument: ${arg}` };
        }
    }
    const hasDirectoryMode = oldRoot || newRoot;
    const hasGitMode = base || head;
    if (hasDirectoryMode && hasGitMode) {
        return { ok: false, error: 'Use either --old/--new or --base/--head, not both.' };
    }
    if (hasGitMode) {
        if (!base) {
            return { ok: false, error: 'Missing required --base <ref> argument.' };
        }
        if (!head) {
            return { ok: false, error: 'Missing required --head <ref> argument.' };
        }
        return { ok: true, mode: 'git', repo, base, head, format, failOn, exceptionsFile };
    }
    if (!oldRoot) {
        return { ok: false, error: 'Missing required --old <dir> argument or --base <ref> argument.' };
    }
    if (!newRoot) {
        return { ok: false, error: 'Missing required --new <dir> argument.' };
    }
    return { ok: true, mode: 'directories', oldRoot, newRoot, format, failOn, exceptionsFile };
}
function isReportFormat(value) {
    return value === 'text' || value === 'markdown' || value === 'json' || value === 'github';
}
function isRating(value) {
    return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}
const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
    process.exitCode = await main();
}
function usage() {
    return [
        `CapabilityEcho ${packageVersion()}`,
        '',
        'Usage:',
        '  capabilityecho --version',
        '  capabilityecho diff --old <dir> --new <dir> [--exceptions <path>] [--format text|markdown|json|github] [--fail-on none|low|medium|high|critical]',
        '  capabilityecho diff --repo <repo> --base <ref> --head <ref> [--exceptions <path>] [--format text|markdown|json|github] [--fail-on none|low|medium|high|critical]'
    ].join('\n');
}
function packageVersion() {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
        throw new Error('CapabilityEcho package version is missing.');
    }
    return packageJson.version;
}
