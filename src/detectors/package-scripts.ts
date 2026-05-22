import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configPath, isRecord, lineOfJsonKey, lineOfJsonStringValue, readJsonObjectWithSource } from '../discovery.js';
import { listGitChangedFiles, listPackageJsonFiles, readFileAtGitRef } from '../git-diff.js';
import { isPackageJsonFile } from '../paths.js';
import type { Finding } from '../types.js';

const LIFECYCLE_KEYS = ['postinstall', 'preinstall', 'prepare', 'install'] as const;

export type PackageDiffMode =
  | { mode: 'directories'; oldRoot: string; newRoot: string }
  | { mode: 'git'; repo: string; base: string; head: string };

export async function detectPackageScripts(mode: PackageDiffMode): Promise<Finding[]> {
  const packageFiles =
    mode.mode === 'directories'
      ? await listPackageJsonFiles(mode.newRoot)
      : (await listChangedPackageJsonFiles(mode.repo, mode.base, mode.head));

  const findings: Finding[] = [];
  for (const file of packageFiles) {
    const oldScripts = await readScriptsAt(mode, file, 'old');
    const newScripts = await readScriptsAt(mode, file, 'new');
    const newText = await readPackageTextAt(mode, file, 'new');
    findings.push(...compareScripts(file, oldScripts, newScripts, newText));
  }

  return findings;
}

export async function listChangedPackageJsonFiles(repo: string, base: string, head: string): Promise<string[]> {
  return (await listGitChangedFiles(repo, base, head)).filter(isPackageJsonFile);
}

async function readScriptsAt(
  mode: PackageDiffMode,
  file: string,
  side: 'old' | 'new'
): Promise<Record<string, string>> {
  const text = await readPackageTextAt(mode, file, side);
  if (!text) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
      return {};
    }

    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.scripts)) {
      if (typeof value === 'string') {
        scripts[key] = value;
      }
    }
    return scripts;
  } catch {
    return {};
  }
}

export async function readPackageTextAt(mode: PackageDiffMode, file: string, side: 'old' | 'new'): Promise<string> {
  if (mode.mode === 'directories') {
    const root = side === 'old' ? mode.oldRoot : mode.newRoot;
    try {
      return await readFile(configPath(root, file), 'utf8');
    } catch {
      return '';
    }
  }

  const ref = side === 'old' ? mode.base : mode.head;
  return (await readFileAtGitRef(mode.repo, ref, file)) ?? '';
}

function compareScripts(
  file: string,
  oldScripts: Record<string, string>,
  newScripts: Record<string, string>,
  newText: string
): Finding[] {
  const findings: Finding[] = [];

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
    if (LIFECYCLE_KEYS.includes(key as (typeof LIFECYCLE_KEYS)[number])) {
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

function analyzeScriptContent(file: string, key: string, script: string, newText: string): Finding[] {
  const findings: Finding[] = [];
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
