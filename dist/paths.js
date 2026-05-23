const EXCLUDED_PATHS = new Set([
    '.mcp.json',
    '.cursor/mcp.json',
    '.vscode/mcp.json',
    '.codeium/windsurf/mcp_config.json',
    '.claude/settings.json',
    '.codex/config.toml',
    'AGENTS.md'
]);
export function normalizeRelativePath(relativePath) {
    return relativePath.replace(/\\/g, '/');
}
export function isExcluded(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (EXCLUDED_PATHS.has(normalized)) {
        return true;
    }
    return normalized.startsWith('.cursor/rules/');
}
export function isScannable(relativePath) {
    return surfaceForPath(relativePath) !== undefined;
}
export function surfaceForPath(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (isExcluded(normalized)) {
        return undefined;
    }
    if (normalized === 'package.json' || normalized.endsWith('/package.json')) {
        return 'package';
    }
    if (isNpmLockfile(normalized)) {
        return 'package';
    }
    if (isPythonManifestFile(normalized)) {
        return 'package';
    }
    if (normalized.startsWith('.github/workflows/') && /\.(ya?ml)$/i.test(normalized)) {
        return 'workflow';
    }
    if (isDockerfile(normalized)) {
        return 'container';
    }
    if (isJsFile(normalized) || isPyFile(normalized) || isShellFile(normalized)) {
        return 'source';
    }
    return undefined;
}
export function isTestFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (normalized.includes('__tests__/') || normalized.includes('/tests/')) {
        return true;
    }
    if (/(^|\/)test_[^/]+\.py$/i.test(normalized) || /_test\.py$/i.test(normalized)) {
        return true;
    }
    return /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(normalized);
}
export function isCommentLine(content) {
    const trimmed = content.trim();
    return (trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('*/') ||
        trimmed.startsWith('#'));
}
export function isWorkflowFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    return normalized.startsWith('.github/workflows/') && /\.(ya?ml)$/i.test(normalized);
}
export function isPackageJsonFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    return normalized === 'package.json' || normalized.endsWith('/package.json');
}
export function isNpmLockfile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const name = normalized.split('/').pop() ?? normalized;
    return name === 'package-lock.json' || name === 'npm-shrinkwrap.json';
}
export function isPythonManifestFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const name = normalized.split('/').pop() ?? normalized;
    if (name === 'pyproject.toml' || name === 'Pipfile') {
        return true;
    }
    // requirements.txt and friends: requirements.txt, requirements-dev.txt,
    // requirements/base.txt, requirements/dev.txt.
    if (/^requirements(?:-[\w.-]+)?\.txt$/i.test(name)) {
        return true;
    }
    return normalized.startsWith('requirements/') && name.endsWith('.txt');
}
export function isJsFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(normalized);
}
export function isPyFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    return /\.(py|pyw)$/i.test(normalized);
}
export function isShellFile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    return /\.(sh|bash|zsh|ps1|psm1)$/i.test(normalized);
}
export function isDockerfile(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const name = normalized.split('/').pop() ?? normalized;
    return /^Dockerfile(?:\..+)?$/i.test(name);
}
