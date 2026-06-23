import { parseToml, lineOfTomlKey } from 'agent-gov-core';
import type { Finding, TextDiffInput } from '../types.js';

// Python-side equivalent of the JS package risk list.
// Adding any of these is, by itself, capability expansion: the agent
// gets a network, subprocess, browser-automation, or RCE-shaped primitive
// transitively, even if the call site isn't in the diff.
const HIGH_CAPABILITY_PY_DEPS = new Set<string>([
  // Headless browsers / UI automation.
  'playwright', 'selenium', 'pyppeteer', 'splinter', 'helium',
  // HTTP clients.
  'requests', 'httpx', 'aiohttp', 'urllib3', 'pycurl', 'grequests', 'tornado',
  // Subprocess / PTY / shell wrappers.
  'sh', 'pexpect', 'plumbum', 'sarge', 'invoke', 'fabric', 'fabric2', 'fabric3',
  // SSH / remote execution.
  'paramiko', 'asyncssh', 'spurplus', 'spur',
  // Code-execution-shaped libraries.
  'restrictedpython', 'asteval',
]);

const TELEMETRY_PY_DEPS = new Set<string>([
  'sentry-sdk', 'opentelemetry-sdk', 'datadog', 'ddtrace',
  'newrelic', 'segment-analytics-python', 'posthog', 'mixpanel',
  'rollbar', 'bugsnag',
]);

export function detectPythonDeps(files: TextDiffInput[]): Finding[] {
  const findings: Finding[] = [];
  for (const input of files) {
    findings.push(...compareManifest(input.file, input.oldText, input.newText));
  }

  return findings;
}

interface PyDep {
  /** Lower-cased, normalized PEP-503 name. */
  name: string;
  /** Source line in the manifest the dep was declared on, 1-based. */
  line?: number;
}

function compareManifest(file: string, oldText: string, newText: string): Finding[] {
  const oldDeps = readManifestDeps(file, oldText);
  const newDeps = readManifestDeps(file, newText);
  const findings: Finding[] = [];
  const oldNames = new Set(oldDeps.map((d) => d.name));

  for (const dep of newDeps) {
    if (oldNames.has(dep.name)) {
      continue;
    }

    if (HIGH_CAPABILITY_PY_DEPS.has(dep.name)) {
      findings.push({
        kind: 'capability_echo.high_capability_dep_added',
        surface: 'package',
        severity: 'high',
        file,
        line: dep.line,
        subject: dep.name,
        message: `Added Python dependency "${dep.name}" can reach the network, spawn subprocesses, or evaluate code.`,
        recommendation: 'Confirm this dependency is required for the stated change and that its usage is scoped.'
      });
      continue;
    }

    if (TELEMETRY_PY_DEPS.has(dep.name)) {
      findings.push({
        kind: 'capability_echo.telemetry_dep_added',
        surface: 'package',
        severity: 'medium',
        file,
        line: dep.line,
        subject: dep.name,
        message: `Added Python telemetry/analytics dependency "${dep.name}" — ships an outbound network surface by default.`,
        recommendation: 'Verify the telemetry destination, payload, and opt-out posture.'
      });
    }
  }

  return findings;
}

function readManifestDeps(file: string, text: string): PyDep[] {
  if (!text.trim()) {
    return [];
  }

  const name = file.split('/').pop() ?? file;
  if (name === 'pyproject.toml') {
    return readPyprojectDeps(text);
  }
  if (name === 'Pipfile') {
    return readPipfileDeps(text);
  }

  return readRequirementsTxtDeps(text);
}

function readRequirementsTxtDeps(text: string): PyDep[] {
  const deps: PyDep[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNumber = i + 1;

    // Strip trailing comments and surrounding whitespace.
    const noComment = raw.replace(/(?:^|\s)#.*$/, '').trim();
    if (!noComment) {
      continue;
    }

    // Editable / VCS / URL installs: pip allows `pkg @ git+https://…` or
    // `-e git+…#egg=pkg`. Pull the name out where we can. Must be checked
    // BEFORE the pip-option skip below, because `-e` lines are options that
    // still name a single dep via their #egg= fragment.
    const eggMatch = noComment.match(/#egg=([A-Za-z0-9_.\-]+)/);
    if (eggMatch) {
      deps.push({ name: normalizePyName(eggMatch[1]), line: lineNumber });
      continue;
    }

    // Skip remaining pip options and includes — they don't name a single dep.
    if (noComment.startsWith('-') || noComment.startsWith('--')) {
      continue;
    }

    // Standard `name[extras]==1.0; marker` or `name @ url`.
    const nameMatch = noComment.match(/^([A-Za-z0-9_.\-]+)/);
    if (!nameMatch) {
      continue;
    }

    deps.push({ name: normalizePyName(nameMatch[1]), line: lineNumber });
  }

  return deps;
}

function readPyprojectDeps(text: string): PyDep[] {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const deps: PyDep[] = [];

  // PEP 621: [project] dependencies + optional-dependencies.*
  const project = parsed.project;
  if (isRecord(project)) {
    if (Array.isArray(project.dependencies)) {
      for (const spec of project.dependencies) {
        const dep = pep508NameFrom(spec);
        if (dep) {
          deps.push({ name: dep, line: lineOfPep508InProject(text, 'project.dependencies', dep) });
        }
      }
    }

    const optional = project['optional-dependencies'];
    if (isRecord(optional)) {
      for (const group of Object.values(optional)) {
        if (!Array.isArray(group)) {
          continue;
        }
        for (const spec of group) {
          const dep = pep508NameFrom(spec);
          if (dep) {
            deps.push({ name: dep, line: lineOfPep508InProject(text, 'project.optional-dependencies', dep) });
          }
        }
      }
    }
  }

  // Poetry: [tool.poetry.dependencies] is a table keyed by package name.
  const tool = parsed.tool;
  if (isRecord(tool)) {
    const poetry = isRecord(tool.poetry) ? tool.poetry : undefined;
    if (poetry) {
      pushPoetrySection(deps, text, 'tool.poetry.dependencies', poetry.dependencies);
      pushPoetrySection(deps, text, 'tool.poetry.dev-dependencies', poetry['dev-dependencies']);
      const groups = poetry.group;
      if (isRecord(groups)) {
        for (const [groupName, group] of Object.entries(groups)) {
          if (isRecord(group) && isRecord(group.dependencies)) {
            pushPoetrySection(deps, text, `tool.poetry.group.${groupName}.dependencies`, group.dependencies);
          }
        }
      }
    }
  }

  return deps;
}

function pushPoetrySection(
  deps: PyDep[],
  text: string,
  tablePath: string,
  table: unknown
): void {
  if (!isRecord(table)) {
    return;
  }
  for (const name of Object.keys(table)) {
    if (name === 'python') {
      continue;
    }
    const normalized = normalizePyName(name);
    const dottedKey = `${tablePath}.${name}`;
    const line = lineOfTomlKey(text, dottedKey);
    deps.push({ name: normalized, line: line === 0 ? undefined : line });
  }
}

function readPipfileDeps(text: string): PyDep[] {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const deps: PyDep[] = [];
  for (const section of ['packages', 'dev-packages']) {
    const table = parsed[section];
    if (!isRecord(table)) {
      continue;
    }
    for (const name of Object.keys(table)) {
      const normalized = normalizePyName(name);
      const dottedKey = `${section}.${name}`;
      const line = lineOfTomlKey(text, dottedKey);
      deps.push({ name: normalized, line: line === 0 ? undefined : line });
    }
  }

  return deps;
}

function pep508NameFrom(spec: unknown): string | undefined {
  if (typeof spec !== 'string') {
    return undefined;
  }
  const match = spec.trim().match(/^([A-Za-z0-9_.\-]+)/);
  return match ? normalizePyName(match[1]) : undefined;
}

function lineOfPep508InProject(text: string, _tableKey: string, name: string): number | undefined {
  // PEP 621 lists deps inside an inline array, so we don't get a TOML key
  // for each dep. Locate by looking for the dep name inside a quoted string,
  // anywhere in the file. Imperfect but better than no annotation.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`["']\\s*${escaped}\\b`, 'i');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      return i + 1;
    }
  }
  return undefined;
}

// PEP 503 name normalization: lowercase, runs of [-_.] collapse to '-'.
function normalizePyName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
