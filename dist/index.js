#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runCapabilityDiff } from './diff.js';
import { renderReport } from './report.js';
export async function main(argv = process.argv.slice(2)) {
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
        ? await runCapabilityDiff({ mode: 'directories', oldRoot: parsed.oldRoot, newRoot: parsed.newRoot })
        : await runCapabilityDiff({ mode: 'git', repo: parsed.repo, base: parsed.base, head: parsed.head });
    process.stdout.write(renderReport(report, parsed.format));
    return 0;
}
function parseDiffArgs(argv) {
    let oldRoot;
    let newRoot;
    let base;
    let head;
    let repo = process.cwd();
    let format = 'text';
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
        else if (arg === '--format') {
            if (!isReportFormat(value)) {
                return { ok: false, error: `Invalid format: ${value ?? ''}` };
            }
            format = value;
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
        return { ok: true, mode: 'git', repo, base, head, format };
    }
    if (!oldRoot) {
        return { ok: false, error: 'Missing required --old <dir> argument or --base <ref> argument.' };
    }
    if (!newRoot) {
        return { ok: false, error: 'Missing required --new <dir> argument.' };
    }
    return { ok: true, mode: 'directories', oldRoot, newRoot, format };
}
function isReportFormat(value) {
    return value === 'text' || value === 'markdown' || value === 'json' || value === 'github';
}
const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
    process.exitCode = await main();
}
function usage() {
    return [
        'Usage:',
        '  capabilityecho diff --old <dir> --new <dir> [--format text|markdown|json|github]',
        '  capabilityecho diff --repo <repo> --base <ref> --head <ref> [--format text|markdown|json|github]'
    ].join('\n');
}
