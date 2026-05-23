import { isCommentLine, isPyFile, isTestFile } from '../paths.js';
// Python capability detection. Agents that ship code edits in Python -
// which is most of them once you leave the frontend - can quietly expand
// reach by adding a `requests.post`, a `subprocess.Popen`, or an `eval`
// without ever touching .mcp.json or .claude/settings.json. These are
// the same shapes detect-js-capability flags for the JS world.
export function detectPyCapability(lines, newFileContents = {}) {
    const findings = [];
    const secretVarsByFile = collectSecretVariables(lines, newFileContents);
    for (const added of lines) {
        if (!isPyFile(added.file) || isCommentLine(added.content)) {
            continue;
        }
        const testFile = isTestFile(added.file);
        findings.push(...detectPyNetwork(added, testFile));
        findings.push(...detectPySecretExfil(added, testFile, secretVarsByFile.get(added.file) ?? new Set()));
        findings.push(...detectPySubprocess(added, testFile));
        findings.push(...detectPyDynamicExec(added, testFile));
        findings.push(...detectPyUnsafeDeserialize(added, testFile));
    }
    return findings;
}
function collectSecretVariables(lines, newFileContents) {
    const varsByFile = new Map();
    const aliasesByFile = new Map();
    for (const [file, content] of Object.entries(newFileContents)) {
        if (!isPyFile(file)) {
            continue;
        }
        aliasesByFile.set(file, parseEnvImportAliases(content));
    }
    for (const added of lines) {
        if (!isPyFile(added.file)) {
            continue;
        }
        addSecretVariable(varsByFile, added.file, added.content, aliasesByFile.get(added.file) ?? defaultAliases());
    }
    for (const [file, content] of Object.entries(newFileContents)) {
        if (!isPyFile(file)) {
            continue;
        }
        const aliases = aliasesByFile.get(file) ?? defaultAliases();
        for (const line of content.split(/\r?\n/)) {
            addSecretVariable(varsByFile, file, line, aliases);
        }
    }
    return varsByFile;
}
function defaultAliases() {
    return { getenv: new Set(['getenv']), environ: new Set(['environ']) };
}
function parseEnvImportAliases(content) {
    const aliases = defaultAliases();
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*from\s+os\s+import\s+(.+?)(?:\s*#.*)?$/);
        if (!match) {
            continue;
        }
        for (const part of match[1].split(',')) {
            const named = part.match(/\s*(getenv|environ)(?:\s+as\s+([A-Za-z_][\w]*))?\s*/);
            if (named) {
                aliases[named[1]].add(named[2] ?? named[1]);
            }
        }
    }
    return aliases;
}
function addSecretVariable(varsByFile, file, content, aliases) {
    const getenvUnion = [...aliases.getenv].map(escapeRegExp).join('|');
    const environUnion = [...aliases.environ].map(escapeRegExp).join('|');
    const secretName = '[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*';
    const pattern = new RegExp(String.raw `^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:(?:os\.)?(?:${environUnion})\s*(?:\[\s*['"]${secretName}['"]\s*\]|\.get\s*\(\s*['"]${secretName}['"])|(?:os\.)?(?:${getenvUnion})\s*\(\s*['"]${secretName}['"])`, 'i');
    const match = content.match(pattern);
    if (!match) {
        return;
    }
    const vars = varsByFile.get(file) ?? new Set();
    vars.add(match[1]);
    varsByFile.set(file, vars);
}
function detectPyNetwork(added, testFile) {
    // Common network entry points across requests, httpx, aiohttp, and the
    // urllib family (including the Python 2 legacy `urllib2` that still
    // appears in older agent-generated code).
    if (!isPyHighLevelNetwork(added.content) && !isPyLowLevelNetwork(added.content)) {
        return [];
    }
    // High-level libraries take URLs as arguments — gate on a literal external
    // URL on the same added line to keep false positives down. Low-level
    // primitives (socket.socket, http.client.HTTPConnection) operate on host
    // strings or AF_INET pairs and do not always carry a URL, so we don't
    // require one for those.
    if (isPyHighLevelNetwork(added.content) && !/(?:https?:\/\/|['"]https?:\/\/)/i.test(added.content)) {
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
function isPyHighLevelNetwork(content) {
    return /\b(?:requests|httpx)\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\burllib(?:2)?\.(?:request\.)?urlopen\s*\(|\burlopen\s*\(|\burllib\.request\.urlretrieve\s*\(|\baiohttp\.(?:ClientSession|request)\s*\(/i.test(content);
}
function isPyLowLevelNetwork(content) {
    // Raw socket / TLS / HTTP-client primitives. These are the "did not fire
    // in live probes" gap Codex flagged — the agent can reach the network
    // without going through requests/httpx.
    return /\bsocket\.socket\s*\(|\bsocket\.create_connection\s*\(|\bssl\.create_default_context\s*\(|\bhttp\.client\.(?:HTTPSConnection|HTTPConnection)\s*\(|\bhttplib\.(?:HTTPS?Connection)\s*\(|\bftplib\.FTP(?:_TLS)?\s*\(|\bsmtplib\.SMTP(?:_SSL)?\s*\(|\btelnetlib\.Telnet\s*\(|\bparamiko\.(?:SSHClient|Transport)\s*\(|\basyncio\.open_connection\s*\(/i.test(content);
}
function detectPySecretExfil(added, testFile, secretVariables) {
    if (!isPyExternalRequest(added.content) ||
        (!referencesPyEnvSecret(added.content) && !referencesSecretVariable(added.content, secretVariables))) {
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
function isPyExternalRequest(content) {
    return (isPyHighLevelNetwork(content) && /(?:https?:\/\/|['"]https?:\/\/)/i.test(content));
}
function referencesPyEnvSecret(content) {
    return (/\b(?:os\.)?environ\s*(?:\[\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]\s*\]|\.get\s*\(\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"])/i.test(content) ||
        /\b(?:os\.)?getenv\s*\(\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]/i.test(content));
}
function referencesSecretVariable(content, secretVariables) {
    return [...secretVariables].some((name) => new RegExp(String.raw `\b${escapeRegExp(name)}\b`).test(content));
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function detectPySubprocess(added, testFile) {
    // Subprocess and shell-execution surfaces. `commands.getoutput` is the
    // Python 2 legacy still seen in older agent-generated code.
    const subprocessPattern = /\bsubprocess\.(?:run|call|Popen|check_call|check_output|getoutput|getstatusoutput)\s*\(|\bos\.(?:system|popen|execv\w*|spawnv?\w*)\s*\(|\bcommands\.getoutput\s*\(|\bpty\.spawn\s*\(/i;
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
function detectPyDynamicExec(added, testFile) {
    // Dynamic code execution. We also catch `__import__` and
    // `importlib.import_module` with a string literal argument — these are
    // the standard primitives for "load whatever the LLM names next."
    const dynamicPattern = /\beval\s*\(|\bexec\s*\(|\bcompile\s*\(|\b__import__\s*\(|\bimportlib\.import_module\s*\(/i;
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
function detectPyUnsafeDeserialize(added, testFile) {
    // pickle.load and marshal.load on attacker-controlled bytes are a
    // remote-code-execution primitive. yaml.load (without SafeLoader) is
    // the same shape and is the most common real-world footgun.
    const unsafeDeserializePattern = /\bpickle\.(?:load|loads)\s*\(|\bmarshal\.(?:load|loads)\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)/i;
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
