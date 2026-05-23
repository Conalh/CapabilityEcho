import { isRecord, lineOfJsonStringValue, lineOfJsonKey } from '../discovery.js';
import { listPackageJsonFiles } from '../git-diff.js';
import { listChangedPackageJsonFiles, readPackageTextAt } from './package-scripts.js';
// Adding a dependency is, by itself, a capability expansion: the agent
// now has whatever the dep can do, transitively. Some additions are
// materially higher-leverage than others — a headless browser, a
// subprocess wrapper, or an arbitrary-fetch HTTP client lets the agent
// reach the network or the OS in ways the existing audit detects only
// when used. Catching them at the manifest layer flags the intent.
const HIGH_CAPABILITY_DEPS = new Set([
    // Headless browsers and full UI automation.
    'puppeteer', 'puppeteer-core', 'playwright', 'playwright-core',
    'cypress', 'webdriverio', 'selenium-webdriver', 'nightwatch',
    // Subprocess and PTY wrappers.
    'execa', 'cross-spawn', 'node-pty', 'shelljs', 'zx', 'tinyspawn',
    // Arbitrary HTTP clients (the agent can now fetch anywhere without
    // touching `fetch` or `axios.get` in code we'd catch via js-capability).
    'node-fetch', 'undici', 'got', 'axios', 'request', 'superagent',
    // Remote-code-execution-shaped libraries.
    'vm2', 'isolated-vm',
    // Network primitives.
    'socks-proxy-agent', 'https-proxy-agent', 'ssh2', 'node-ssh',
    // Telemetry / analytics SDKs that ship a phone-home in their happy
    // path (medium risk — flagged separately below).
]);
const TELEMETRY_DEPS = new Set([
    '@segment/analytics-node', 'mixpanel', 'amplitude-js', 'posthog-js',
    '@sentry/node', '@sentry/browser'
]);
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
export async function detectPackageDeps(mode) {
    const files = mode.mode === 'directories'
        ? await listPackageJsonFiles(mode.newRoot)
        : await listChangedPackageJsonFiles(mode.repo, mode.base, mode.head);
    const findings = [];
    for (const file of files) {
        const oldText = await readPackageTextAt(mode, file, 'old');
        const newText = await readPackageTextAt(mode, file, 'new');
        findings.push(...compareDeps(file, oldText, newText));
    }
    return findings;
}
function compareDeps(file, oldText, newText) {
    const oldDeps = readAllDeps(oldText);
    const newDeps = readAllDeps(newText);
    const findings = [];
    for (const [name, version] of newDeps.entries()) {
        if (oldDeps.has(name)) {
            continue;
        }
        if (HIGH_CAPABILITY_DEPS.has(name)) {
            findings.push({
                kind: 'capability_echo.high_capability_dep_added',
                surface: 'package',
                severity: 'high',
                file,
                line: lineOfJsonKey(newText, name) ?? lineOfJsonStringValue(newText, version),
                subject: name,
                message: `Added dependency "${name}" can reach the network, spawn subprocesses, or evaluate code.`,
                recommendation: 'Confirm this dependency is required for the stated change and that its usage is scoped.'
            });
            continue;
        }
        if (TELEMETRY_DEPS.has(name)) {
            findings.push({
                kind: 'capability_echo.telemetry_dep_added',
                surface: 'package',
                severity: 'medium',
                file,
                line: lineOfJsonKey(newText, name) ?? lineOfJsonStringValue(newText, version),
                subject: name,
                message: `Added telemetry/analytics dependency "${name}" — ships an outbound network surface by default.`,
                recommendation: 'Verify the telemetry destination, payload, and opt-out posture.'
            });
        }
    }
    return findings;
}
function readAllDeps(text) {
    const result = new Map();
    if (!text.trim()) {
        return result;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return result;
    }
    if (!isRecord(parsed)) {
        return result;
    }
    for (const section of DEP_SECTIONS) {
        const block = parsed[section];
        if (!isRecord(block)) {
            continue;
        }
        for (const [name, version] of Object.entries(block)) {
            if (typeof version === 'string') {
                result.set(name, version);
            }
        }
    }
    return result;
}
