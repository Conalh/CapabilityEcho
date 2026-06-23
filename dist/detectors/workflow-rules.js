const WRITE_PERMISSION_SCOPES = new Set([
    'actions',
    'artifact-metadata',
    'attestations',
    'checks',
    'code-quality',
    'contents',
    'deployments',
    'discussions',
    'id-token',
    'issues',
    'packages',
    'pages',
    'pull-requests',
    'security-events',
    'statuses'
]);
export function isWritePermissionScope(scope) {
    return WRITE_PERMISSION_SCOPES.has(scope.toLowerCase());
}
export function isBroadWritePermission(value) {
    return /^(?:write|write-all|admin)$/i.test(value);
}
export function isWritePermissionLine(content) {
    const match = content.match(/^\s*([A-Za-z-]+)\s*:\s*write\b/i);
    return match ? isWritePermissionScope(match[1]) : false;
}
export function isPullRequestTargetLine(content) {
    return /^\s*pull_request_target\s*:/i.test(content);
}
export function hasPullRequestTargetWorkflow(content) {
    return content.split(/\r?\n/).some(isPullRequestTargetLine);
}
export function referencesPullRequestHead(content) {
    if (/github\.event\.pull_request\.head\.(?:sha|ref|repo\.full_name|repo\.clone_url)/i.test(content)) {
        return true;
    }
    return /\brefs\/pull\/.+?\/merge\b/i.test(content);
}
export function extractWorkflowUsesRef(content) {
    return content.match(/^\s*(?:-\s*)?uses\s*:\s*['"]?([^'"\s#]+)['"]?/i)?.[1];
}
export function isMutableActionRef(actionRef) {
    if (actionRef.startsWith('./') || actionRef.startsWith('../') || actionRef.startsWith('/')) {
        return false;
    }
    if (/^docker:\/\//i.test(actionRef)) {
        return false;
    }
    const refSeparatorIndex = actionRef.lastIndexOf('@');
    if (refSeparatorIndex === -1) {
        return false;
    }
    const versionRef = actionRef.slice(refSeparatorIndex + 1);
    return !/^[0-9a-f]{40}$/i.test(versionRef);
}
export function referencesExternalRequestCommand(content) {
    return /\b(curl|wget|Invoke-WebRequest|fetch\s*\()/i.test(content);
}
export function referencesExternalUrlOrVariable(content) {
    const urls = content.match(/https?:\/\/[^\s'"`)]+/gi) ?? [];
    for (const url of urls) {
        if (!isLocalUrl(url)) {
            return true;
        }
    }
    return urls.length === 0 && /\$\{?\w|\$\{\{/.test(content);
}
export function referencesExternalRequest(content) {
    return referencesExternalRequestCommand(content) && referencesExternalUrlOrVariable(content);
}
export function isLocalUrl(url) {
    return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url);
}
export function referencesShellVariable(content, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(String.raw `(?:\$\{${escaped}\}|\$${escaped}\b|%${escaped}%)`).test(content);
}
export function hasDockerSocketMount(content) {
    return /\/var\/run\/docker\.sock(?::\/var\/run\/docker\.sock)?/i.test(content);
}
export function hasPrivilegedDockerRun(content) {
    return /\bdocker\s+run\b.*\s--privileged(?:\s|$)/i.test(content);
}
