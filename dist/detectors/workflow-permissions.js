import { isWorkflowFile } from '../paths.js';
export function detectWorkflowPermissions(lines) {
    const findings = [];
    for (const added of lines) {
        if (!isWorkflowFile(added.file)) {
            continue;
        }
        findings.push(...detectWritePermissions(added));
        findings.push(...detectExternalCurl(added));
        findings.push(...detectSecretExfil(added));
    }
    return findings;
}
function detectWritePermissions(added) {
    const content = added.content;
    if (!/permissions\s*:/i.test(content) && !/\b(contents|packages|id-token)\s*:\s*write\b/i.test(content)) {
        return [];
    }
    if (/\b(contents|packages|id-token)\s*:\s*write\b/i.test(content)) {
        return [
            {
                kind: 'workflow_permission_write',
                severity: 'high',
                file: added.file,
                line: added.line,
                subject: 'GitHub Actions write permission',
                message: 'Workflow grants repository or package write permissions.',
                recommendation: 'Use the narrowest permission scope required for this job.'
            }
        ];
    }
    if (/\bpermissions\s*:\s*(write|admin)\b/i.test(content)) {
        return [
            {
                kind: 'workflow_permission_write',
                severity: 'high',
                file: added.file,
                line: added.line,
                subject: 'GitHub Actions broad write permission',
                message: 'Workflow grants broad write or admin permissions.',
                recommendation: 'Prefer explicit per-resource permissions instead of top-level write/admin.'
            }
        ];
    }
    return [];
}
function detectExternalCurl(added) {
    if (!/\b(curl|wget|Invoke-WebRequest|fetch\s*\()/i.test(added.content)) {
        return [];
    }
    return [
        {
            kind: 'workflow_external_curl',
            severity: 'medium',
            file: added.file,
            line: added.line,
            subject: 'Workflow external request',
            message: 'Workflow step performs an external network request.',
            recommendation: 'Verify the URL, payload, and whether the request is necessary in CI.'
        }
    ];
}
function detectSecretExfil(added) {
    const content = added.content;
    const hasSecretRef = /\$\{\{\s*secrets\.|\$\{?\s*secrets\.|env\.[A-Z0-9_]+/i.test(content);
    const hasNetwork = /\b(curl|wget|Invoke-WebRequest|fetch\s*\()/i.test(content);
    const hasPipe = /\|\s*(bash|sh|powershell|pwsh)/i.test(content);
    if (!hasSecretRef || !hasNetwork) {
        return [];
    }
    return [
        {
            kind: 'workflow_secret_exfil_pattern',
            severity: 'high',
            file: added.file,
            line: added.line,
            subject: 'Workflow secret exfiltration pattern',
            message: 'Workflow step references secrets or env values alongside an external request or shell pipe.',
            recommendation: 'Review whether secrets could leave the runner through this step.'
        }
    ];
}
