import type { AddedLine, Finding } from '../types.js';
import { isWorkflowFile } from '../paths.js';

const githubTokenWritePermissionPattern =
  /^\s*(?:actions|artifact-metadata|attestations|checks|code-quality|contents|deployments|discussions|id-token|issues|packages|pages|pull-requests|security-events|statuses)\s*:\s*write\b/i;

export function detectWorkflowPermissions(lines: AddedLine[], newFileContents: Record<string, string> = {}): Finding[] {
  const findings: Finding[] = [];
  const pullRequestTargetFiles = new Set(
    lines.filter((line) => isWorkflowFile(line.file) && isPullRequestTargetLine(line.content)).map((line) => line.file)
  );
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
    findings.push(...detectSecretExfil(added, secretEnvVarsByFile.get(added.file) ?? new Set<string>()));
    findings.push(...detectDockerHostControl(added));
  }

  return findings;
}

function collectSecretEnvVars(lines: AddedLine[], newFileContents: Record<string, string>): Map<string, Set<string>> {
  const varsByFile = new Map<string, Set<string>>();
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

function addSecretEnvVar(varsByFile: Map<string, Set<string>>, file: string, content: string): void {
  const match = content.match(/^\s*([A-Z_][A-Z0-9_]*)\s*:\s*.*\$\{\{\s*secrets\./i);
  if (!match) {
    return;
  }

  const vars = varsByFile.get(file) ?? new Set<string>();
  vars.add(match[1]);
  varsByFile.set(file, vars);
}

function detectWritePermissions(added: AddedLine): Finding[] {
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

function detectPullRequestTarget(added: AddedLine): Finding[] {
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

function detectPullRequestHeadCheckoutOnTarget(added: AddedLine, hasPullRequestTarget: boolean): Finding[] {
  if (!hasPullRequestTarget || !referencesPullRequestHead(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.workflow_pr_head_checkout_on_target',
      surface: 'workflow',
      severity: 'high',
      file: added.file,
      line: added.line,
      subject: 'GitHub Actions PR-head reference under pull_request_target',
      message: 'Workflow under pull_request_target references the pull request head (SHA, ref, or repo), which can let untrusted PR code run with the elevated token context.',
      recommendation: 'Use pull_request for untrusted PR code, or avoid referencing PR head SHA/ref/repo under pull_request_target.'
    }
  ];
}

function isPullRequestTargetLine(content: string): boolean {
  return /^\s*pull_request_target\s*:/i.test(content);
}

function hasPullRequestTargetWorkflow(content: string): boolean {
  return content.split(/\r?\n/).some(isPullRequestTargetLine);
}

function referencesPullRequestHead(content: string): boolean {
  return /github\.event\.pull_request\.head\.(?:sha|ref|repo\.full_name)/i.test(content);
}

function detectSelfHostedRunner(added: AddedLine): Finding[] {
  if (
    !/^\s*runs-on\s*:\s*(?:.*\bself-hosted\b|.*\[\s*self-hosted\b)/i.test(added.content) &&
    !/^\s*-\s*self-hosted\s*(?:#.*)?$/i.test(added.content)
  ) {
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

function detectMutableActionRef(added: AddedLine): Finding[] {
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

function extractWorkflowUsesRef(content: string): string | undefined {
  return content.match(/^\s*(?:-\s*)?uses\s*:\s*['"]?([^'"\s#]+)['"]?/i)?.[1];
}

function isLocalActionRef(actionRef: string): boolean {
  return actionRef.startsWith('./') || actionRef.startsWith('../') || actionRef.startsWith('/');
}

function isMutableActionVersionRef(versionRef: string): boolean {
  return /^(main|master|trunk|develop|dev|latest|head)$/i.test(versionRef);
}

function detectExternalCurl(added: AddedLine): Finding[] {
  if (!/\b(curl|wget|Invoke-WebRequest|fetch\s*\()/i.test(added.content)) {
    return [];
  }

  if (!referencesExternalUrlOrVariable(added.content)) {
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

function referencesExternalUrlOrVariable(content: string): boolean {
  const urls = content.match(/https?:\/\/[^\s'"`)]+/gi) ?? [];
  for (const url of urls) {
    if (!isLocalUrl(url)) {
      return true;
    }
  }

  if (urls.length === 0 && /\$\{?\w|\$\{\{/.test(content)) {
    return true;
  }

  return false;
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url);
}

function detectSecretsInherit(added: AddedLine): Finding[] {
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

function detectSecretExfil(added: AddedLine, secretEnvVars: Set<string>): Finding[] {
  const content = added.content;
  const hasSecretRef =
    /\$\{\{\s*secrets\.|\$\{?\s*secrets\.|env\.[A-Z0-9_]+/i.test(content) ||
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

function referencesShellVariable(content: string, name: string): boolean {
  const escapedName = escapeRegExp(name);
  return new RegExp(String.raw`(?:\$\{${escapedName}\}|\$${escapedName}\b|%${escapedName}%)`).test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectDockerHostControl(added: AddedLine): Finding[] {
  const findings: Finding[] = [];
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
