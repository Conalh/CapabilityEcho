import { isRecord, lineOfJsonKey, lineOfJsonStringValue } from '../discovery.js';
import type { Finding, TextDiffInput } from '../types.js';
import { HIGH_CAPABILITY_JS_DEPS, TELEMETRY_JS_DEPS } from './js-package-risk.js';

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

export function detectPackageDeps(files: TextDiffInput[]): Finding[] {
  const findings: Finding[] = [];
  for (const input of files) {
    findings.push(...compareDeps(input.file, input.oldText, input.newText));
  }

  return findings;
}

function compareDeps(file: string, oldText: string, newText: string): Finding[] {
  const oldDeps = readAllDeps(oldText);
  const newDeps = readAllDeps(newText);
  const findings: Finding[] = [];

  for (const [name, version] of newDeps.entries()) {
    if (oldDeps.has(name)) {
      continue;
    }

    if (HIGH_CAPABILITY_JS_DEPS.has(name)) {
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

    if (TELEMETRY_JS_DEPS.has(name)) {
      findings.push({
        kind: 'capability_echo.telemetry_dep_added',
        surface: 'package',
        severity: 'medium',
        file,
        line: lineOfJsonKey(newText, name) ?? lineOfJsonStringValue(newText, version),
        subject: name,
        message: `Added telemetry/analytics dependency "${name}" - ships an outbound network surface by default.`,
        recommendation: 'Verify the telemetry destination, payload, and opt-out posture.'
      });
    }
  }

  return findings;
}

function readAllDeps(text: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!text.trim()) {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
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
