import { isCommentLine, isJsFile, isTestFile } from '../paths.js';
export function detectJsCapability(lines, newFileContents = {}) {
    const findings = [];
    const secretVarsByFile = collectSecretVariables(lines, newFileContents);
    const linesByFile = groupLinesByFile(lines);
    for (const added of lines) {
        if (!isJsFile(added.file) || isCommentLine(added.content)) {
            continue;
        }
        const testFile = isTestFile(added.file);
        const sameFile = linesByFile.get(added.file) ?? [];
        findings.push(...detectFetch(added, testFile, sameFile));
        findings.push(...detectSecretExfil(added, testFile, secretVarsByFile.get(added.file) ?? new Set(), sameFile));
        findings.push(...detectSubprocess(added, testFile));
        findings.push(...detectDynamicEval(added, testFile, sameFile));
    }
    return findings;
}
function groupLinesByFile(lines) {
    const byFile = new Map();
    for (const line of lines) {
        if (!isJsFile(line.file)) {
            continue;
        }
        const arr = byFile.get(line.file) ?? [];
        arr.push(line);
        byFile.set(line.file, arr);
    }
    // The diff layer hands us lines in source order per file already, but
    // sort defensively so the lookahead window is reliable.
    for (const arr of byFile.values()) {
        arr.sort((left, right) => left.line - right.line);
    }
    return byFile;
}
// How many added lines forward to scan for a continuation argument like a URL
// literal or a non-literal import specifier. 3 covers `fetch(\n  url,\n  opts\n)`
// without picking up unrelated calls below.
const SPLIT_LINE_LOOKAHEAD = 3;
function nextLines(added, sameFile) {
    const out = [];
    for (let offset = 1; offset <= SPLIT_LINE_LOOKAHEAD; offset += 1) {
        const next = sameFile.find((entry) => entry.line === added.line + offset);
        if (!next || isCommentLine(next.content)) {
            // Stop at the first gap or comment — keeps the window aligned with the
            // current call expression and avoids walking into unrelated code.
            break;
        }
        out.push(next);
    }
    return out;
}
function hasExternalUrlInLines(lines) {
    return lines.some((entry) => /(?:https?:\/\/|['"]https?:\/\/)/i.test(entry.content));
}
function hasLocalFetchPathInLines(lines) {
    // Matches the same-origin guard for `fetch('/path')` / `axios.get('/path')`
    // on a continuation line where the call is on the previous added line.
    return lines.some((entry) => /^\s*['"`]\//.test(entry.content));
}
function collectSecretVariables(lines, newFileContents) {
    const varsByFile = new Map();
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
function addSecretVariable(varsByFile, file, content) {
    const directMatch = content.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env(?:\.[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\b|\[\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]\s*\])/i);
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
function isSecretShapedName(name) {
    return /^[A-Z_][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*$/i.test(name);
}
function addVariable(varsByFile, file, name) {
    const vars = varsByFile.get(file) ?? new Set();
    vars.add(name);
    varsByFile.set(file, vars);
}
function detectFetch(added, testFile, sameFile) {
    // Network entry points across the JS ecosystem.
    //  - fetch / axios / got / ky / node-fetch (high-level)
    //  - http(s).get / http(s).request (Node built-in low-level)
    //  - undici.request / fetch
    //  - new XMLHttpRequest (browser-shaped, sometimes in cross-target code)
    const networkPattern = /(?:\bfetch\s*\(|\baxios\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\bgot\s*\(|\bky\.(?:get|post|put|delete|patch|head)\s*\(|\bhttps?\.(?:get|request)\s*\(|\bundici\.(?:request|fetch|stream|pipeline)\s*\(|new\s+XMLHttpRequest\s*\()/i;
    if (!networkPattern.test(added.content)) {
        return [];
    }
    const lookahead = nextLines(added, sameFile);
    const hasUrlSameLine = /(?:https?:\/\/|['"]https?:\/\/)/i.test(added.content);
    if (!hasUrlSameLine && !hasExternalUrlInLines(lookahead)) {
        return [];
    }
    // Same-origin literal paths (`fetch('/api/x')`) are not external. The other
    // clients (axios, got, http.get, etc.) require a hostname so we only need to
    // gate `fetch(`/`axios.*(` here.
    if (/(?:fetch\s*\(\s*['"`]\/|axios\.(?:get|post|put|delete|patch|head|options|request)\s*\(\s*['"`]\/)/i.test(added.content)) {
        return [];
    }
    // Split-line same-origin: `fetch(` on the call line, then `'/api/x'` on the
    // very next added line. Skip without firing.
    const callEndsAtParen = /(?:fetch|axios\.\w+)\s*\(\s*$/i.test(added.content);
    if (callEndsAtParen && !hasUrlSameLine && hasLocalFetchPathInLines(lookahead) && !hasExternalUrlInLines(lookahead)) {
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
function detectSecretExfil(added, testFile, secretVariables, sameFile) {
    if (!isExternalHttpRequest(added, sameFile)) {
        return [];
    }
    // Secret references can live on the call line OR on continuation lines for
    // split-line `fetch(\n  url,\n  { headers: { Auth: env.SECRET } })` calls.
    const chunk = [added, ...nextLines(added, sameFile)];
    const hasSecret = chunk.some((line) => referencesEnvSecret(line.content) || referencesSecretVariable(line.content, secretVariables));
    if (!hasSecret) {
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
function isExternalHttpRequest(added, sameFile) {
    const isCallLine = /(?:\bfetch\s*\(|\baxios\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\bgot\s*\(|\bky\.(?:get|post|put|delete|patch|head)\s*\(|\bhttps?\.(?:get|request)\s*\(|\bundici\.(?:request|fetch|stream|pipeline)\s*\()/i.test(added.content);
    if (!isCallLine) {
        return false;
    }
    if (/(?:https?:\/\/|['"]https?:\/\/)/i.test(added.content)) {
        return true;
    }
    // Split-line: URL is on a following added line.
    return hasExternalUrlInLines(nextLines(added, sameFile));
}
function referencesEnvSecret(content) {
    return /\bprocess\.env(?:\.[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*\b|\[\s*['"][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*['"]\s*\])/i.test(content);
}
function referencesSecretVariable(content, secretVariables) {
    return [...secretVariables].some((name) => new RegExp(String.raw `\b${escapeRegExp(name)}\b`).test(content));
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function detectSubprocess(added, testFile) {
    // Full Node child_process API surface plus the Bun and Deno equivalents.
    // execFile/execFileSync were missing from the v0 detector and are common
    // in agent-generated code — closing that gap here.
    if (!/(?:\bchild_process\b|\bexecSync\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecFileSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(|\bfork\s*\(|\bBun\.spawn(?:Sync)?\s*\(|\bDeno\.(?:Command|run)\s*\()/i.test(added.content)) {
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
function detectDynamicEval(added, testFile, sameFile) {
    // Dynamic import() with a non-literal specifier is a "load whatever the
    // LLM names next" primitive. We approximate "non-literal" by skipping
    // calls whose argument starts with a quote — those are static and safe-ish
    // (relative imports stay sandboxed by the host). Anything else (variable,
    // template literal, expression) flags.
    if (!isDynamicImport(added, sameFile) &&
        !/(?:\beval\s*\(|new\s+Function\s*\(|vm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s*\()/i.test(added.content)) {
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
function isDynamicImport(added, sameFile) {
    const sameLineMatch = added.content.match(/\bimport\s*\(\s*([^)]*)/i);
    if (sameLineMatch && sameLineMatch[1].trim() !== '') {
        return !/^['"`]/.test(sameLineMatch[1].trim());
    }
    // `import(` with the specifier on a following added line. Flag when the
    // specifier doesn't start with a string literal.
    const opensImport = /\bimport\s*\(\s*$/i.test(added.content);
    if (!opensImport) {
        return false;
    }
    const lookahead = nextLines(added, sameFile);
    for (const next of lookahead) {
        const trimmed = next.content.trim();
        if (trimmed === '') {
            continue;
        }
        return !/^['"`]/.test(trimmed);
    }
    return false;
}
