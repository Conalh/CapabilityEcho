import type { AddedLine, Finding } from '../types.js';
import { isCommentLine, isJsFile, isTestFile } from '../paths.js';

export function detectJsCapability(lines: AddedLine[], newFileContents: Record<string, string> = {}): Finding[] {
  const findings: Finding[] = [];
  const secretVarsByFile = collectSecretVariables(lines, newFileContents);

  for (const added of lines) {
    if (!isJsFile(added.file) || isCommentLine(added.content)) {
      continue;
    }

    const testFile = isTestFile(added.file);
    findings.push(...detectFetch(added, testFile));
    findings.push(...detectSecretExfil(added, testFile, secretVarsByFile.get(added.file) ?? new Set<string>()));
    findings.push(...detectSubprocess(added, testFile));
    findings.push(...detectDynamicEval(added, testFile));
  }

  return findings;
}

function collectSecretVariables(lines: AddedLine[], newFileContents: Record<string, string>): Map<string, Set<string>> {
  const varsByFile = new Map<string, Set<string>>();
  for (const added of lines) {
    if (!isJsFile(added.file)) {
      continue;
    }

    addSecretVariable(varsByFile, added.file, added.content);
  }

  for (const [file, content] of Object.entries(newFileContents)) {
    if (!isJsFile(file)) {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      addSecretVariable(varsByFile, file, line);
    }
  }

  return varsByFile;
}

function addSecretVariable(varsByFile: Map<string, Set<string>>, file: string, content: string): void {
  const match = content.match(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\b/i
  );
  if (!match) {
    return;
  }

  const vars = varsByFile.get(file) ?? new Set<string>();
  vars.add(match[1]);
  varsByFile.set(file, vars);
}

function detectFetch(added: AddedLine, testFile: boolean): Finding[] {
  if (!/(?:fetch\s*\(|axios\.(?:get|post|put|delete|patch|request)\s*\(|got\s*\()/i.test(added.content)) {
    return [];
  }

  if (!/(?:https?:\/\/|['"]https?:\/\/)/i.test(added.content)) {
    return [];
  }

  if (/(?:fetch\s*\(\s*['"`]\/|axios\.(?:get|post|put|delete|patch|request)\s*\(\s*['"`]\/)/i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.external_fetch_added',
      surface: 'source',
      severity: testFile ? 'low' : 'medium',
      file: added.file,
      line: added.line,
      subject: 'External network fetch',
      message: 'Added code performs an external HTTP request that expands network reach.',
      recommendation: 'Review the endpoint, data sent, and whether the request belongs in this change.'
    }
  ];
}

function detectSecretExfil(added: AddedLine, testFile: boolean, secretVariables: Set<string>): Finding[] {
  if (
    !isExternalHttpRequest(added.content) ||
    (!referencesEnvSecret(added.content) && !referencesSecretVariable(added.content, secretVariables))
  ) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.source_secret_exfil_pattern',
      surface: 'source',
      severity: testFile ? 'medium' : 'high',
      file: added.file,
      line: added.line,
      subject: 'Source secret exfiltration pattern',
      message: 'Added source code sends environment-secret-shaped data to an external endpoint.',
      recommendation: 'Do not send env secrets to external services unless the endpoint and payload are explicitly required.'
    }
  ];
}

function isExternalHttpRequest(content: string): boolean {
  return (
    /(?:fetch\s*\(|axios\.(?:get|post|put|delete|patch|request)\s*\(|got\s*\()/i.test(content) &&
    /(?:https?:\/\/|['"]https?:\/\/)/i.test(content)
  );
}

function referencesEnvSecret(content: string): boolean {
  return /\bprocess\.env\.[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\b/i.test(content);
}

function referencesSecretVariable(content: string, secretVariables: Set<string>): boolean {
  return [...secretVariables].some((name) => new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(content));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectSubprocess(added: AddedLine, testFile: boolean): Finding[] {
  if (
    !/(?:child_process|execSync\s*\(|exec\s*\(|spawnSync\s*\(|spawn\s*\(|Bun\.spawn\s*\()/i.test(added.content)
  ) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.subprocess_spawn_added',
      surface: 'source',
      severity: testFile ? 'low' : 'high',
      file: added.file,
      line: added.line,
      subject: 'Subprocess spawn',
      message: 'Added code can spawn shell commands or subprocesses.',
      recommendation: 'Confirm the command source is trusted and scoped to the task.'
    }
  ];
}

function detectDynamicEval(added: AddedLine, testFile: boolean): Finding[] {
  if (!/(?:\beval\s*\(|new\s+Function\s*\(|vm\.runInNewContext\s*\()/i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.dynamic_eval_added',
      surface: 'source',
      severity: testFile ? 'medium' : 'critical',
      file: added.file,
      line: added.line,
      subject: 'Dynamic code execution',
      message: 'Added code can evaluate dynamic JavaScript at runtime.',
      recommendation: 'Avoid eval-style execution unless strictly required and heavily constrained.'
    }
  ];
}
