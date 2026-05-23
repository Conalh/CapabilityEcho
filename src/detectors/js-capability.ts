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
  const directMatch = content.match(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env(?:\.[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\b|\[\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]\s*\])/i
  );
  if (directMatch) {
    addVariable(varsByFile, file, directMatch[1]);
    return;
  }

  // Destructuring: const { API_TOKEN, GITHUB_SECRET: gh } = process.env
  const destructureMatch = content.match(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*process\.env\b/i);
  if (!destructureMatch) {
    return;
  }

  for (const part of destructureMatch[1].split(',')) {
    const renamed = part.match(/\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*/);
    if (renamed && isSecretShapedName(renamed[1])) {
      addVariable(varsByFile, file, renamed[2]);
      continue;
    }

    const bare = part.match(/\s*([A-Za-z_$][\w$]*)\s*/);
    if (bare && isSecretShapedName(bare[1])) {
      addVariable(varsByFile, file, bare[1]);
    }
  }
}

function isSecretShapedName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*$/i.test(name);
}

function addVariable(varsByFile: Map<string, Set<string>>, file: string, name: string): void {
  const vars = varsByFile.get(file) ?? new Set<string>();
  vars.add(name);
  varsByFile.set(file, vars);
}

function detectFetch(added: AddedLine, testFile: boolean): Finding[] {
  // Network entry points across the JS ecosystem.
  //  - fetch / axios / got / ky / node-fetch (high-level)
  //  - http(s).get / http(s).request (Node built-in low-level)
  //  - undici.request / fetch
  //  - new XMLHttpRequest (browser-shaped, sometimes in cross-target code)
  const networkPattern =
    /(?:\bfetch\s*\(|\baxios\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\bgot\s*\(|\bky\.(?:get|post|put|delete|patch|head)\s*\(|\bhttps?\.(?:get|request)\s*\(|\bundici\.(?:request|fetch|stream|pipeline)\s*\(|new\s+XMLHttpRequest\s*\()/i;
  if (!networkPattern.test(added.content)) {
    return [];
  }

  if (!/(?:https?:\/\/|['"]https?:\/\/)/i.test(added.content)) {
    return [];
  }

  // Same-origin literal paths (`fetch('/api/x')`) are not external. The other
  // clients (axios, got, http.get, etc.) require a hostname so we only need to
  // gate `fetch(`/`axios.*(` here.
  if (/(?:fetch\s*\(\s*['"`]\/|axios\.(?:get|post|put|delete|patch|head|options|request)\s*\(\s*['"`]\/)/i.test(added.content)) {
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
    /(?:\bfetch\s*\(|\baxios\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\bgot\s*\(|\bky\.(?:get|post|put|delete|patch|head)\s*\(|\bhttps?\.(?:get|request)\s*\(|\bundici\.(?:request|fetch|stream|pipeline)\s*\()/i.test(content) &&
    /(?:https?:\/\/|['"]https?:\/\/)/i.test(content)
  );
}

function referencesEnvSecret(content: string): boolean {
  return /\bprocess\.env(?:\.[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\b|\[\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]\s*\])/i.test(content);
}

function referencesSecretVariable(content: string, secretVariables: Set<string>): boolean {
  return [...secretVariables].some((name) => new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(content));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectSubprocess(added: AddedLine, testFile: boolean): Finding[] {
  // Full Node child_process API surface plus the Bun and Deno equivalents.
  // execFile/execFileSync were missing from the v0 detector and are common
  // in agent-generated code — closing that gap here.
  if (
    !/(?:\bchild_process\b|\bexecSync\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecFileSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(|\bfork\s*\(|\bBun\.spawn(?:Sync)?\s*\(|\bDeno\.(?:Command|run)\s*\()/i.test(added.content)
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
  // Dynamic import() with a non-literal specifier is a "load whatever the
  // LLM names next" primitive. We approximate "non-literal" by skipping
  // calls whose argument starts with a quote — those are static and safe-ish
  // (relative imports stay sandboxed by the host). Anything else (variable,
  // template literal, expression) flags.
  const dynamicImportMatch = added.content.match(/\bimport\s*\(\s*([^)]*)/i);
  const dynamicImport =
    dynamicImportMatch !== null &&
    !/^['"`]/.test(dynamicImportMatch[1].trim()) &&
    dynamicImportMatch[1].trim() !== '';

  if (
    !dynamicImport &&
    !/(?:\beval\s*\(|new\s+Function\s*\(|vm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s*\()/i.test(added.content)
  ) {
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
