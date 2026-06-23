// Adding any of these is, by itself, capability expansion: the agent now has
// network, subprocess, browser-automation, or RCE-shaped primitives available
// transitively, even before a call site appears in the diff.
export const HIGH_CAPABILITY_JS_DEPS = new Set([
    // Headless browsers and full UI automation.
    'puppeteer',
    'puppeteer-core',
    'playwright',
    'playwright-core',
    'cypress',
    'webdriverio',
    'selenium-webdriver',
    'nightwatch',
    // Subprocess and PTY wrappers.
    'execa',
    'cross-spawn',
    'node-pty',
    'shelljs',
    'zx',
    'tinyspawn',
    // Arbitrary HTTP clients.
    'node-fetch',
    'undici',
    'got',
    'axios',
    'request',
    'superagent',
    // Remote-code-execution-shaped libraries.
    'vm2',
    'isolated-vm',
    // Network primitives.
    'socks-proxy-agent',
    'https-proxy-agent',
    'ssh2',
    'node-ssh'
]);
export const TELEMETRY_JS_DEPS = new Set([
    '@segment/analytics-node',
    'mixpanel',
    'amplitude-js',
    'posthog-js',
    '@sentry/node',
    '@sentry/browser'
]);
