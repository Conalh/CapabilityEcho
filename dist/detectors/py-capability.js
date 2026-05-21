import { isCommentLine, isPyFile, isTestFile } from '../paths.js';
// Python capability detection. Agents that ship code edits in Python -
// which is most of them once you leave the frontend - can quietly expand
// reach by adding a `requests.post`, a `subprocess.Popen`, or an `eval`
// without ever touching .mcp.json or .claude/settings.json. These are
// the same shapes detect-js-capability flags for the JS world.
export function detectPyCapability(lines) {
    const findings = [];
    for (const added of lines) {
        if (!isPyFile(added.file) || isCommentLine(added.content)) {
            continue;
        }
        const testFile = isTestFile(added.file);
        findings.push(...detectPyNetwork(added, testFile));
        findings.push(...detectPySubprocess(added, testFile));
        findings.push(...detectPyDynamicExec(added, testFile));
        findings.push(...detectPyUnsafeDeserialize(added, testFile));
    }
    return findings;
}
function detectPyNetwork(added, testFile) {
    // Common network entry points across requests, httpx, aiohttp, and the
    // urllib family (including the Python 2 legacy `urllib2` that still
    // appears in older agent-generated code).
    const networkVerbPattern = /\b(?:requests|httpx)\.(?:get|post|put|delete|patch|head|options|request)\s*\(|\burllib(?:2)?\.(?:request\.)?urlopen\s*\(|\burlopen\s*\(|\burllib\.request\.urlretrieve\s*\(|\baiohttp\.ClientSession\s*\(/i;
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
            kind: 'external_fetch_added',
            severity: testFile ? 'low' : 'medium',
            file: added.file,
            line: added.line,
            subject: 'External network call (Python)',
            message: 'Added Python performs an external HTTP request that expands network reach.',
            recommendation: 'Review the endpoint, request payload, and whether the call belongs in this change.'
        }
    ];
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
            kind: 'subprocess_spawn_added',
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
            kind: 'dynamic_eval_added',
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
            kind: 'unsafe_deserialize_added',
            severity: testFile ? 'medium' : 'critical',
            file: added.file,
            line: added.line,
            subject: 'Unsafe deserialization (Python)',
            message: 'Added Python deserializes untrusted-shaped input (pickle / marshal / yaml.load).',
            recommendation: 'Use yaml.safe_load and avoid pickle/marshal on data crossing trust boundaries.'
        }
    ];
}
