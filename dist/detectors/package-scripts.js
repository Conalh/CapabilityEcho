import { readFile } from 'node:fs/promises';
import { configPath, isRecord, lineOfJsonKey, lineOfJsonStringValue } from '../discovery.js';
import { listGitChangedFiles, listPackageJsonFiles, readFileAtGitRef } from '../git-diff.js';
import { isPackageJsonFile } from '../paths.js';
const LIFECYCLE_KEYS = ['postinstall', 'preinstall', 'prepare', 'install'];
export async function detectPackageScripts(mode) {
    const packageFiles = mode.mode === 'directories'
        ? await listPackageJsonFiles(mode.newRoot)
        : (await listChangedPackageJsonFiles(mode.repo, mode.base, mode.head));
    const findings = [];
    for (const file of packageFiles) {
        const oldScripts = await readScriptsAt(mode, file, 'old');
        const newScripts = await readScriptsAt(mode, file, 'new');
        const newText = await readPackageTextAt(mode, file, 'new');
        findings.push(...compareScripts(file, oldScripts, newScripts, newText));
    }
    return findings;
}
export async function listChangedPackageJsonFiles(repo, base, head) {
    return (await listGitChangedFiles(repo, base, head)).filter(isPackageJsonFile);
}
async function readScriptsAt(mode, file, side) {
    const text = await readPackageTextAt(mode, file, side);
    if (!text) {
        return {};
    }
    try {
        const parsed = JSON.parse(text);
        if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
            return {};
        }
        const scripts = {};
        for (const [key, value] of Object.entries(parsed.scripts)) {
            if (typeof value === 'string') {
                scripts[key] = value;
            }
        }
        return scripts;
    }
    catch {
        return {};
    }
}
export async function readPackageTextAt(mode, file, side) {
    if (mode.mode === 'directories') {
        const root = side === 'old' ? mode.oldRoot : mode.newRoot;
        try {
            return await readFile(configPath(root, file), 'utf8');
        }
        catch {
            return '';
        }
    }
    const ref = side === 'old' ? mode.base : mode.head;
    return (await readFileAtGitRef(mode.repo, ref, file)) ?? '';
}
function compareScripts(file, oldScripts, newScripts, newText) {
    const findings = [];
    for (const key of LIFECYCLE_KEYS) {
        const newValue = newScripts[key];
        if (!newValue) {
            continue;
        }
        const oldValue = oldScripts[key];
        if (oldValue === newValue) {
            continue;
        }
        const line = lineOfJsonKey(newText, key) ?? lineOfJsonStringValue(newText, newValue);
        findings.push({
            kind: 'lifecycle_script_added',
            surface: 'package',
            severity: 'high',
            file,
            line,
            subject: `package.json ${key} script`,
            message: `Added or changed npm ${key} lifecycle script.`,
            recommendation: 'Review lifecycle scripts carefully; they run automatically on install.'
        });
        findings.push(...analyzeScriptContent(file, key, newValue, newText));
    }
    for (const [key, newValue] of Object.entries(newScripts)) {
        if (LIFECYCLE_KEYS.includes(key)) {
            continue;
        }
        const oldValue = oldScripts[key];
        if (oldValue === newValue) {
            continue;
        }
        findings.push(...analyzeScriptContent(file, key, newValue, newText));
    }
    return findings;
}
function analyzeScriptContent(file, key, script, newText) {
    const findings = [];
    const line = lineOfJsonStringValue(newText, script) ?? lineOfJsonKey(newText, key);
    if (/(?:curl[^\n|]*\|\s*(?:ba)?sh|wget[^\n|]*\|\s*sh|Invoke-Expression|iex\s*\()/i.test(script)) {
        findings.push({
            kind: 'script_pipe_to_shell',
            surface: 'package',
            severity: 'critical',
            file,
            line,
            subject: `package.json ${key} pipe-to-shell`,
            message: 'Script downloads and pipes content directly into a shell.',
            recommendation: 'Replace remote pipe-to-shell patterns with pinned, reviewable install steps.'
        });
    }
    if (/\b(curl|wget|npm publish)\b/i.test(script) || /\bnpx\b(?![^\s]*@\d+\.\d+\.\d+)/i.test(script)) {
        findings.push({
            kind: 'script_network_command',
            surface: 'package',
            severity: 'medium',
            file,
            line,
            subject: `package.json ${key} network command`,
            message: 'Script performs a network or publish command.',
            recommendation: 'Pin package versions and verify remote commands before merge.'
        });
    }
    return findings;
}
