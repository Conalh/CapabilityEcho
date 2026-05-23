import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord, lineOfJsonKey } from '../discovery.js';
import { configPath } from '../discovery.js';
import { listGitChangedFiles, readFileAtGitRef } from '../git-diff.js';
import { isNpmLockfile } from '../paths.js';
// Lockfile coverage catches *transitive* capability drift that direct
// package.json scanning misses. A child upgrade can pull `node-fetch`
// into the tree without touching the manifest at all.
const HIGH_CAPABILITY_DEPS = new Set([
    'puppeteer', 'puppeteer-core', 'playwright', 'playwright-core',
    'cypress', 'webdriverio', 'selenium-webdriver', 'nightwatch',
    'execa', 'cross-spawn', 'node-pty', 'shelljs', 'zx', 'tinyspawn',
    'node-fetch', 'undici', 'got', 'axios', 'request', 'superagent',
    'vm2', 'isolated-vm',
    'socks-proxy-agent', 'https-proxy-agent', 'ssh2', 'node-ssh',
]);
const TELEMETRY_DEPS = new Set([
    '@segment/analytics-node', 'mixpanel', 'amplitude-js', 'posthog-js',
    '@sentry/node', '@sentry/browser',
]);
export async function detectNpmLockfile(mode) {
    const files = mode.mode === 'directories'
        ? await listLockfilesInTree(mode.newRoot)
        : (await listGitChangedFiles(mode.repo, mode.base, mode.head)).filter(isNpmLockfile);
    const findings = [];
    for (const file of files) {
        const oldText = await readLockfileAt(mode, file, 'old');
        const newText = await readLockfileAt(mode, file, 'new');
        findings.push(...compareLockfile(file, oldText, newText));
    }
    return findings;
}
async function listLockfilesInTree(root, current = '') {
    const entries = await readdir(join(root, current), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
        }
        const relativePath = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            files.push(...(await listLockfilesInTree(root, relativePath)));
            continue;
        }
        if (isNpmLockfile(relativePath)) {
            files.push(relativePath.replace(/\\/g, '/'));
        }
    }
    return files;
}
async function readLockfileAt(mode, file, side) {
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
function compareLockfile(file, oldText, newText) {
    const oldEntries = readPackagesMap(oldText);
    const newEntries = readPackagesMap(newText);
    const findings = [];
    const oldPaths = new Set(oldEntries.map((entry) => entry.path));
    for (const entry of newEntries) {
        if (oldPaths.has(entry.path)) {
            // Already present — skip even if hasInstallScript flipped; we only
            // flag newly-introduced packages so we don't churn on lockfile rewrites.
            continue;
        }
        const line = lineOfJsonKey(newText, entry.path);
        if (HIGH_CAPABILITY_DEPS.has(entry.name)) {
            findings.push({
                kind: 'capability_echo.lockfile_high_capability_dep_added',
                surface: 'package',
                severity: 'high',
                file,
                line,
                subject: entry.name,
                message: `Lockfile pulls in "${entry.name}" — a network/subprocess/eval-shaped dependency — that was not previously present.`,
                recommendation: 'Verify the upstream change that introduced this transitive dep is intentional and trusted.'
            });
        }
        else if (TELEMETRY_DEPS.has(entry.name)) {
            findings.push({
                kind: 'capability_echo.lockfile_telemetry_dep_added',
                surface: 'package',
                severity: 'medium',
                file,
                line,
                subject: entry.name,
                message: `Lockfile pulls in telemetry/analytics dependency "${entry.name}" — ships an outbound network surface by default.`,
                recommendation: 'Verify the telemetry destination and whether this transitive addition is intentional.'
            });
        }
        if (entry.hasInstallScript) {
            findings.push({
                kind: 'capability_echo.lockfile_install_script_added',
                surface: 'package',
                severity: 'high',
                file,
                line,
                subject: entry.name,
                message: `Lockfile adds "${entry.name}", which declares an install/postinstall script that runs on \`npm install\`.`,
                recommendation: 'Inspect the package install script before merging; consider `--ignore-scripts` or pinning a reviewed version.'
            });
        }
    }
    return findings;
}
function readPackagesMap(text) {
    if (!text.trim()) {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return [];
    }
    if (!isRecord(parsed) || !isRecord(parsed.packages)) {
        return [];
    }
    const entries = [];
    for (const [path, value] of Object.entries(parsed.packages)) {
        if (!path || !path.startsWith('node_modules/')) {
            continue;
        }
        const name = bareNameFromLockfilePath(path);
        if (!name) {
            continue;
        }
        const hasInstallScript = isRecord(value) && value.hasInstallScript === true;
        entries.push({ path, name, hasInstallScript });
    }
    return entries;
}
function bareNameFromLockfilePath(path) {
    // The "real" package name is whatever follows the LAST `node_modules/`.
    // Handles both flat (`node_modules/foo`) and nested
    // (`node_modules/parent/node_modules/foo`) layouts.
    const marker = 'node_modules/';
    const lastIndex = path.lastIndexOf(marker);
    if (lastIndex < 0) {
        return undefined;
    }
    const tail = path.slice(lastIndex + marker.length);
    if (!tail) {
        return undefined;
    }
    // Scoped: keep `@scope/name`.
    if (tail.startsWith('@')) {
        const slashIndex = tail.indexOf('/');
        if (slashIndex < 0) {
            return undefined;
        }
        const nextSlash = tail.indexOf('/', slashIndex + 1);
        return nextSlash < 0 ? tail : tail.slice(0, nextSlash);
    }
    const slashIndex = tail.indexOf('/');
    return slashIndex < 0 ? tail : tail.slice(0, slashIndex);
}
