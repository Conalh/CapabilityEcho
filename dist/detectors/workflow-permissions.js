import { isWorkflowFile } from '../paths.js';
const githubTokenWritePermissionPattern = /^\s*(?:actions|artifact-metadata|attestations|checks|code-quality|contents|deployments|discussions|id-token|issues|packages|pages|pull-requests|security-events|statuses)\s*:\s*write\b/i;
export function detectWorkflowPermissions(lines, newFileContents = {}) {
    const findings = [];
    const pullRequestTargetFiles = new Set(lines.filter((line) => isWorkflowFile(line.file) && isPullRequestTargetLine(line.content)).map((line) => line.file));
    const secretEnvVarsByFile = collectSecretEnvVars(lines, newFileContents);
    for (const [file, content] of Object.entries(newFileContents)) {
        if (isWorkflowFile(file) && hasPullRequestTargetWorkflow(content)) {
            pullRequestTargetFiles.add(file);
        }
    }
    for (const added of lines) {
        if (!isWorkflowFile(added.file)) {
            continue;
        }
        findings.push(...detectPullRequestTarget(added));
        findings.push(...detectPullRequestHeadCheckoutOnTarget(added, pullRequestTargetFiles.has(added.file)));
        findings.push(...detectSelfHostedRunner(added));
        findings.push(...detectMutableActionRef(added));
        findings.push(...detectWritePermissions(added));
        findings.push(...detectExternalCurl(added));
        findings.push(...detectSecretsInherit(added));
        findings.push(...detectSecretExfil(added, secretEnvVarsByFile.get(added.file) ?? new Set()));
        findings.push(...detectDockerHostControl(added));
    }
    return findings;
}
function collectSecretEnvVars(lines, newFileContents) {
    const varsByFile = new Map();
    for (const added of lines) {
        if (!isWorkflowFile(added.file)) {
            continue;
        }
        addSecretEnvVar(varsByFile, added.file, added.content);
    }
    for (const [file, content] of Object.entries(newFileContents)) {
        if (!isWorkflowFile(file)) {
            continue;
        }
        for (const line of content.split(/\r?\n/)) {
            addSecretEnvVar(varsByFile, file, line);
        }
    }
    return varsByFile;
}
function addSecretEnvVar(varsByFile, file, content) {
    const match = content.match(/^\s*([A-Z_][A-Z0-9_]*)\s*:\s*.*\$\{\{\s*secrets\./i);
    if (!match) {
        return;
    }
    const vars = varsByFile.get(file) ?? new Set();
    vars.add(match[1]);
    varsByFile.set(file, vars);
}
function detectWritePermissions(added) {
    const content = added.content;
    if (!/permissions\s*:/i.test(content) && !githubTokenWritePermissionPattern.test(content)) {
        return [];
    }
    if (githubTokenWritePermissionPattern.test(content)) {
        return [
            {
                kind: 'capability_echo.workflow_permission_write',
                surface: 'workflow',
                severity: 'high',
                file: added.file,
                line: added.line,
                subject: 'GitHub Actions write permission',
                message: 'Workflow grants repository or package write permissions.',
                recommendation: 'Use the narrowest permission scope required for this job.'
            }
        ];
    }
    if (/^\s*permissions\s*:\s*(?:write|write-all|admin)\b/i.test(content)) {
        return [
            {
                kind: 'capability_echo.workflow_permission_write',
                surface: 'workflow',
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
function detectPullRequestTarget(added) {
    if (!isPullRequestTargetLine(added.content)) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.workflow_pull_request_target',
            surface: 'workflow',
            severity: 'high',
            file: added.file,
            line: added.line,
            subject: 'GitHub Actions pull_request_target trigger',
            message: 'Workflow runs on pull_request_target, which can expose elevated token or secret context to PR-triggered automation.',
            recommendation: 'Use pull_request unless elevated base-repository context is required; never run untrusted PR code with pull_request_target privileges.'
        }
    ];
}
function detectPullRequestHeadCheckoutOnTarget(added, hasPullRequestTarget) {
    if (!hasPullRequestTarget || !isPullRequestHeadCheckoutLine(added.content)) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.workflow_pr_head_checkout_on_target',
            surface: 'workflow',
            severity: 'high',
            file: added.file,
            line: added.line,
            subject: 'GitHub Actions PR-head checkout under pull_request_target',
            message: 'Workflow checks out pull request head code in a pull_request_target workflow.',
            recommendation: 'Use pull_request for untrusted PR code, or avoid checking out PR head code under pull_request_target.'
        }
    ];
}
function isPullRequestTargetLine(content) {
    return /^\s*pull_request_target\s*:/i.test(content);
}
function hasPullRequestTargetWorkflow(content) {
    return content.split(/\r?\n/).some(isPullRequestTargetLine);
}
function isPullRequestHeadCheckoutLine(content) {
    return /^\s*(?:ref|repository)\s*:\s*.*github\.event\.pull_request\.head\.(?:sha|ref|repo\.full_name)/i.test(content);
}
function detectSelfHostedRunner(added) {
    if (!/^\s*runs-on\s*:\s*(?:.*\bself-hosted\b|.*\[\s*self-hosted\b)/i.test(added.content) &&
        !/^\s*-\s*self-hosted\s*(?:#.*)?$/i.test(added.content)) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.workflow_self_hosted_runner',
            surface: 'workflow',
            severity: 'high',
            file: added.file,
            line: added.line,
            subject: 'GitHub Actions self-hosted runner',
            message: 'Workflow runs on a self-hosted runner, which can expand PR-triggered automation into private infrastructure.',
            recommendation: 'Use GitHub-hosted runners for untrusted PR code, or isolate self-hosted runners with strict labels, permissions, and cleanup.'
        }
    ];
}
function detectMutableActionRef(added) {
    const actionRef = extractWorkflowUsesRef(added.content);
    if (!actionRef || isLocalActionRef(actionRef) || /^docker:\/\//i.test(actionRef)) {
        return [];
    }
    const refSeparatorIndex = actionRef.lastIndexOf('@');
    if (refSeparatorIndex === -1) {
        return [];
    }
    const versionRef = actionRef.slice(refSeparatorIndex + 1);
    if (!isMutableActionVersionRef(versionRef)) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.workflow_mutable_action_ref',
            surface: 'workflow',
            severity: 'medium',
            file: added.file,
            line: added.line,
            subject: 'GitHub Actions mutable action reference',
            message: 'Workflow uses a mutable remote action reference.',
            recommendation: 'Pin third-party actions to a reviewed commit SHA before merge.'
        }
    ];
}
function extractWorkflowUsesRef(content) {
    return content.match(/^\s*(?:-\s*)?uses\s*:\s*['"]?([^'"\s#]+)['"]?/i)?.[1];
}
function isLocalActionRef(actionRef) {
    return actionRef.startsWith('./') || actionRef.startsWith('../') || actionRef.startsWith('/');
}
function isMutableActionVersionRef(versionRef) {
    return /^(main|master|trunk|develop|dev|latest|head)$/i.test(versionRef);
}
function detectExternalCurl(added) {
    if (!/\b(curl|wget|Invoke-WebRequest|fetch\s*\()/i.test(added.content)) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.workflow_external_curl',
            surface: 'workflow',
            severity: 'medium',
            file: added.file,
            line: added.line,
            subject: 'Workflow external request',
            message: 'Workflow step performs an external network request.',
            recommendation: 'Verify the URL, payload, and whether the request is necessary in CI.'
        }
    ];
}
function detectSecretsInherit(added) {
    if (!/^\s*secrets\s*:\s*inherit\s*(?:#.*)?$/i.test(added.content)) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.workflow_secrets_inherit',
            surface: 'workflow',
            severity: 'high',
            file: added.file,
            line: added.line,
            subject: 'GitHub Actions inherited secrets',
            message: 'Workflow passes all caller secrets to a reusable workflow.',
            recommendation: 'Pass only explicit secrets required by the reusable workflow.'
        }
    ];
}
function detectSecretExfil(added, secretEnvVars) {
    const content = added.content;
    const hasSecretRef = /\$\{\{\s*secrets\.|\$\{?\s*secrets\.|env\.[A-Z0-9_]+/i.test(content) ||
        [...secretEnvVars].some((name) => referencesShellVariable(content, name));
    const hasNetwork = /\b(curl|wget|Invoke-WebRequest|fetch\s*\()/i.test(content);
    const hasPipe = /\|\s*(bash|sh|powershell|pwsh)/i.test(content);
    if (!hasSecretRef || !hasNetwork) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.workflow_secret_exfil_pattern',
            surface: 'workflow',
            severity: 'high',
            file: added.file,
            line: added.line,
            subject: 'Workflow secret exfiltration pattern',
            message: 'Workflow step references secrets or env values alongside an external request or shell pipe.',
            recommendation: 'Review whether secrets could leave the runner through this step.'
        }
    ];
}
function referencesShellVariable(content, name) {
    const escapedName = escapeRegExp(name);
    return new RegExp(String.raw `(?:\$\{${escapedName}\}|\$${escapedName}\b|%${escapedName}%)`).test(content);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function detectDockerHostControl(added) {
    const findings = [];
    const content = added.content;
    if (/\/var\/run\/docker\.sock(?::\/var\/run\/docker\.sock)?/i.test(content)) {
        findings.push({
            kind: 'capability_echo.workflow_docker_socket_mount',
            surface: 'workflow',
            severity: 'critical',
            file: added.file,
            line: added.line,
            subject: 'Workflow Docker socket mount',
            message: 'Workflow mounts the host Docker socket, which can grant control over the runner host.',
            recommendation: 'Avoid Docker socket mounts in CI unless the job is isolated and the image/commands are trusted.'
        });
    }
    if (/\bdocker\s+run\b.*\s--privileged(?:\s|$)/i.test(content)) {
        findings.push({
            kind: 'capability_echo.workflow_privileged_container',
            surface: 'workflow',
            severity: 'high',
            file: added.file,
            line: added.line,
            subject: 'Workflow privileged container',
            message: 'Workflow runs a privileged container, expanding kernel and device-level access in CI.',
            recommendation: 'Use the narrowest container privileges required, and avoid privileged mode for agent-run code.'
        });
    }
    return findings;
}
