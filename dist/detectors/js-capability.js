import { isCommentLine, isJsFile, isTestFile } from '../paths.js';
export function detectJsCapability(lines) {
    const findings = [];
    for (const added of lines) {
        if (!isJsFile(added.file) || isCommentLine(added.content)) {
            continue;
        }
        const testFile = isTestFile(added.file);
        findings.push(...detectFetch(added, testFile));
        findings.push(...detectSubprocess(added, testFile));
        findings.push(...detectDynamicEval(added, testFile));
    }
    return findings;
}
function detectFetch(added, testFile) {
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
            kind: 'external_fetch_added',
            severity: testFile ? 'low' : 'medium',
            file: added.file,
            line: added.line,
            subject: 'External network fetch',
            message: 'Added code performs an external HTTP request that expands network reach.',
            recommendation: 'Review the endpoint, data sent, and whether the request belongs in this change.'
        }
    ];
}
function detectSubprocess(added, testFile) {
    if (!/(?:child_process|execSync\s*\(|exec\s*\(|spawnSync\s*\(|spawn\s*\(|Bun\.spawn\s*\()/i.test(added.content)) {
        return [];
    }
    return [
        {
            kind: 'subprocess_spawn_added',
            severity: testFile ? 'low' : 'high',
            file: added.file,
            line: added.line,
            subject: 'Subprocess spawn',
            message: 'Added code can spawn shell commands or subprocesses.',
            recommendation: 'Confirm the command source is trusted and scoped to the task.'
        }
    ];
}
function detectDynamicEval(added, testFile) {
    if (!/(?:\beval\s*\(|new\s+Function\s*\(|vm\.runInNewContext\s*\()/i.test(added.content)) {
        return [];
    }
    return [
        {
            kind: 'dynamic_eval_added',
            severity: testFile ? 'medium' : 'critical',
            file: added.file,
            line: added.line,
            subject: 'Dynamic code execution',
            message: 'Added code can evaluate dynamic JavaScript at runtime.',
            recommendation: 'Avoid eval-style execution unless strictly required and heavily constrained.'
        }
    ];
}
