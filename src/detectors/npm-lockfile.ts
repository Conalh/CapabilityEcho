import { isRecord, lineOfJsonKey } from '../discovery.js';
import type { Finding, TextDiffInput } from '../types.js';
import { HIGH_CAPABILITY_JS_DEPS, TELEMETRY_JS_DEPS } from './js-package-risk.js';

export function detectNpmLockfile(files: TextDiffInput[]): Finding[] {
  const findings: Finding[] = [];
  for (const input of files) {
    findings.push(...compareLockfile(input.file, input.oldText, input.newText));
  }

  return findings;
}

interface LockEntry {
  /** The lockfile key, e.g. `node_modules/foo` or `node_modules/foo/node_modules/bar`. */
  path: string;
  /** JSON key to use for line annotations. */
  locatorKey: string;
  /** Bare package name extracted from the path (scope-aware). */
  name: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  hasInstallScript: boolean;
}

function compareLockfile(file: string, oldText: string, newText: string): Finding[] {
  const oldEntries = readPackagesMap(oldText);
  const newEntries = readPackagesMap(newText);
  const findings: Finding[] = [];
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

    if ((introduced || metadataChanged) && HIGH_CAPABILITY_JS_DEPS.has(entry.name)) {
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
    } else if ((introduced || metadataChanged) && TELEMETRY_JS_DEPS.has(entry.name)) {
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

function readPackagesMap(text: string): LockEntry[] {
  if (!text.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  if (!isRecord(parsed.packages)) {
    return isRecord(parsed.dependencies) ? readLegacyDependenciesMap(parsed.dependencies) : [];
  }

  const entries: LockEntry[] = [];
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

function readLegacyDependenciesMap(
  dependencies: Record<string, unknown>,
  parentPath = ''
): LockEntry[] {
  const entries: LockEntry[] = [];
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

function lockEntryFromValue(path: string, locatorKey: string, name: string, value: unknown): LockEntry {
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

function lockEntrySignature(entry: LockEntry): string {
  return JSON.stringify({
    version: entry.version ?? '',
    resolved: entry.resolved ?? '',
    integrity: entry.integrity ?? '',
    hasInstallScript: entry.hasInstallScript
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bareNameFromLockfilePath(path: string): string | undefined {
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
