const EXCLUDED_PATHS = new Set([
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.codeium/windsurf/mcp_config.json',
  '.claude/settings.json',
  '.codex/config.toml',
  'AGENTS.md'
]);

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

export function isExcluded(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (EXCLUDED_PATHS.has(normalized)) {
    return true;
  }

  return normalized.startsWith('.cursor/rules/');
}

export function isScannable(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (isExcluded(normalized)) {
    return false;
  }

  if (normalized === 'package.json' || normalized.endsWith('/package.json')) {
    return true;
  }

  if (normalized.startsWith('.github/workflows/') && /\.(ya?ml)$/i.test(normalized)) {
    return true;
  }

  return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(normalized);
}

export function isTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.includes('__tests__/')) {
    return true;
  }

  return /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(normalized);
}

export function isCommentLine(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('*/');
}

export function isWorkflowFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith('.github/workflows/') && /\.(ya?ml)$/i.test(normalized);
}

export function isPackageJsonFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === 'package.json' || normalized.endsWith('/package.json');
}

export function isJsFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(normalized);
}
