import { isRecord, lineOfJsonKey } from '../discovery.js';
import { listSafeFiles, readTextWithinRoot } from '../discovery.js';
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
async function listLockfilesInTree(root) {
    return (await listSafeFiles(root, { includeFile: isNpmLockfile })).files;
}
async function readLockfileAt(mode, file, side) {
    if (mode.mode === 'directories') {
        const root = side === 'old' ? mode.oldRoot : mode.newRoot;
        return (await readTextWithinRoot(root, file)).text;
    }
    const ref = side === 'old' ? mode.base : mode.head;
    return (await readFileAtGitRef(mode.repo, ref, file)) ?? '';
}
function compareLockfile(file, oldText, newText) {
    const oldEntries = readPackagesMap(oldText);
    const newEntries = readPackagesMap(newText);
    const findings = [];
    const oldByPath = new Map(oldEntries.map((entry) => [entry.path, entry]));
    for (const entry of newEntries) {
        const oldEntry = oldByPath.get(entry.path);
        const introduced = oldEntry === undefined;
        const metadataChanged = oldEntry !== undefined && lockEntrySignature(oldEntry) !== lockEntrySignature(entry);
        const installScriptAdded = entry.hasInstallScript && oldEntry?.hasInstallScript !== true;
        if (!introduced && !metadataChanged && !installScriptAdded) {
            continue;
        }
        const line = lineOfJsonKey(newText, entry.locatorKey);
        if ((introduced || metadataChanged) && HIGH_CAPABILITY_DEPS.has(entry.name)) {
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
        else if ((introduced || metadataChanged) && TELEMETRY_DEPS.has(entry.name)) {
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
        if (installScriptAdded) {
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
    if (!isRecord(parsed)) {
        return [];
    }
    if (!isRecord(parsed.packages)) {
        return isRecord(parsed.dependencies) ? readLegacyDependenciesMap(parsed.dependencies) : [];
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
        entries.push(lockEntryFromValue(path, path, name, value));
    }
    return entries;
}
function readLegacyDependenciesMap(dependencies, parentPath = '') {
    const entries = [];
    for (const [name, value] of Object.entries(dependencies)) {
        if (!isRecord(value)) {
            continue;
        }
        const path = parentPath ? `${parentPath}/node_modules/${name}` : `node_modules/${name}`;
        entries.push(lockEntryFromValue(path, name, name, value));
        if (isRecord(value.dependencies)) {
            entries.push(...readLegacyDependenciesMap(value.dependencies, path));
        }
    }
    return entries;
}
function lockEntryFromValue(path, locatorKey, name, value) {
    const record = isRecord(value) ? value : {};
    return {
        path,
        locatorKey,
        name,
        version: stringValue(record.version),
        resolved: stringValue(record.resolved),
        integrity: stringValue(record.integrity),
        hasInstallScript: record.hasInstallScript === true
    };
}
function lockEntrySignature(entry) {
    return JSON.stringify({
        version: entry.version ?? '',
        resolved: entry.resolved ?? '',
        integrity: entry.integrity ?? '',
        hasInstallScript: entry.hasInstallScript
    });
}
function stringValue(value) {
    return typeof value === 'string' ? value : undefined;
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
