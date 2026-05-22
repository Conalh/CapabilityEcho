import type { AddedLine, Finding } from '../types.js';
import { isCommentLine, isPyFile, isTestFile } from '../paths.js';

// Python capability detection. Agents that ship code edits in Python -
// which is most of them once you leave the frontend - can quietly expand
// reach by adding a `requests.post`, a `subprocess.Popen`, or an `eval`
// without ever touching .mcp.json or .claude/settings.json. These are
// the same shapes detect-js-capability flags for the JS world.
export function detectPyCapability(lines: AddedLine[], newFileContents: Record<string, string> = {}): Finding[] {
  const findings: Finding[] = [];
  const secretVarsByFile = collectSecretVariables(lines, newFileContents);

  for (const added of lines) {
    if (!isPyFile(added.file) || isCommentLine(added.content)) {
      continue;
    }

    const testFile = isTestFile(added.file);
    findings.push(...detectPyNetwork(added, testFile));
    findings.push(...detectPySecretExfil(added, testFile, secretVarsByFile.get(added.file) ?? new Set<string>()));
    findings.push(...detectPySubprocess(added, testFile));
    findings.push(...detectPyDynamicExec(added, testFile));
    findings.push(...detectPyUnsafeDeserialize(added, testFile));
  }

  return findings;
}

function collectSecretVariables(lines: AddedLine[], newFileContents: Record<string, string>): Map<string, Set<string>> {
  const varsByFile = new Map<string, Set<string>>();
  for (const added of lines) {
    if (!isPyFile(added.file)) {
      continue;
    }

    addSecretVariable(varsByFile, added.file, added.content);
  }

  for (const [file, content] of Object.entries(newFileContents)) {
    if (!isPyFile(file)) {
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
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:os\.environ\s*(?:\[\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]\s*\]|\.get\s*\(\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"])|os\.getenv\s*\(\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"])/i
  );
  if (!match) {
    return;
  }

  const vars = varsByFile.get(file) ?? new Set<string>();
  vars.add(match[1]);
  varsByFile.set(file, vars);
}

function detectPyNetwork(added: AddedLine, testFile: boolean): Finding[] {
  // Common network entry points across requests, httpx, aiohttp, and the
  // urllib family (including the Python 2 legacy `urllib2` that still
  // appears in older agent-generated code).
  const networkVerbPattern =
    /\b(?:requests|httpx)\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\burllib(?:2)?\.(?:request\.)?urlopen\s*\(|\burlopen\s*\(|\burllib\.request\.urlretrieve\s*\(|\baiohttp\.ClientSession\s*\(/i;
  if (!networkVerbPattern.test(added.content)) {
    return [];
  }

  // Gate on a literal external URL on the same added line — keeps the
  // detector aligned with the JS side and cuts false positives from code
  // that takes the URL from a constant defined elsewhere.
  if (!/(?:https?:\/\/|['"]https?:\/\/)/i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.external_fetch_added',
      surface: 'source',
      severity: testFile ? 'low' : 'medium',
      file: added.file,
      line: added.line,
      subject: 'External network call (Python)',
      message: 'Added Python performs an external HTTP request that expands network reach.',
      recommendation: 'Review the endpoint, request payload, and whether the call belongs in this change.'
    }
  ];
}

function detectPySecretExfil(added: AddedLine, testFile: boolean, secretVariables: Set<string>): Finding[] {
  if (
    !isPyExternalRequest(added.content) ||
    (!referencesPyEnvSecret(added.content) && !referencesSecretVariable(added.content, secretVariables))
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
      subject: 'Source secret exfiltration pattern (Python)',
      message: 'Added Python sends environment-secret-shaped data to an external endpoint.',
      recommendation: 'Do not send env secrets to external services unless the endpoint and payload are explicitly required.'
    }
  ];
}

function isPyExternalRequest(content: string): boolean {
  return (
    /\b(?:requests|httpx)\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\burllib(?:2)?\.(?:request\.)?urlopen\s*\(|\burlopen\s*\(|\burllib\.request\.urlretrieve\s*\(|\baiohttp\.ClientSession\s*\(/i.test(content) &&
    /(?:https?:\/\/|['"]https?:\/\/)/i.test(content)
  );
}

function referencesPyEnvSecret(content: string): boolean {
  return (
    /\bos\.environ\s*(?:\[\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]\s*\]|\.get\s*\(\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"])/i.test(content) ||
    /\bos\.getenv\s*\(\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]/i.test(content)
  );
}

function referencesSecretVariable(content: string, secretVariables: Set<string>): boolean {
  return [...secretVariables].some((name) => new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(content));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectPySubprocess(added: AddedLine, testFile: boolean): Finding[] {
  // Subprocess and shell-execution surfaces. `commands.getoutput` is the
  // Python 2 legacy still seen in older agent-generated code.
  const subprocessPattern =
    /\bsubprocess\.(?:run|call|Popen|check_call|check_output|getoutput|getstatusoutput)\s*\(|\bos\.(?:system|popen|execv\w*|spawnv?\w*)\s*\(|\bcommands\.getoutput\s*\(|\bpty\.spawn\s*\(/i;
  if (!subprocessPattern.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.subprocess_spawn_added',
      surface: 'source',
      severity: testFile ? 'low' : 'high',
      file: added.file,
      line: added.line,
      subject: 'Subprocess spawn (Python)',
      message: 'Added Python can spawn shell commands or subprocesses.',
      recommendation: 'Confirm the command source is trusted and scoped to the task.'
    }
  ];
}

function detectPyDynamicExec(added: AddedLine, testFile: boolean): Finding[] {
  // Dynamic code execution. We also catch `__import__` and
  // `importlib.import_module` with a string literal argument — these are
  // the standard primitives for "load whatever the LLM names next."
  const dynamicPattern =
    /\beval\s*\(|\bexec\s*\(|\bcompile\s*\(|\b__import__\s*\(|\bimportlib\.import_module\s*\(/i;
  if (!dynamicPattern.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.dynamic_eval_added',
      surface: 'source',
      severity: testFile ? 'medium' : 'critical',
      file: added.file,
      line: added.line,
      subject: 'Dynamic code execution (Python)',
      message: 'Added Python can evaluate dynamic code or import modules by name at runtime.',
      recommendation: 'Avoid eval-style execution unless strictly required; never feed user input to these.'
    }
  ];
}

function detectPyUnsafeDeserialize(added: AddedLine, testFile: boolean): Finding[] {
  // pickle.load and marshal.load on attacker-controlled bytes are a
  // remote-code-execution primitive. yaml.load (without SafeLoader) is
  // the same shape and is the most common real-world footgun.
  const unsafeDeserializePattern =
    /\bpickle\.(?:load|loads)\s*\(|\bmarshal\.(?:load|loads)\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)/i;
  if (!unsafeDeserializePattern.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.unsafe_deserialize_added',
      surface: 'source',
      severity: testFile ? 'medium' : 'critical',
      file: added.file,
      line: added.line,
      subject: 'Unsafe deserialization (Python)',
      message: 'Added Python deserializes untrusted-shaped input (pickle / marshal / yaml.load).',
      recommendation: 'Use yaml.safe_load and avoid pickle/marshal on data crossing trust boundaries.'
    }
  ];
}
