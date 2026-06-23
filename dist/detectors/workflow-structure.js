import { isMap, isSeq, lineOfNode, parseWorkflow, scalarValue, spanOfNode, spanOverlapsAddedLines, } from '../workflow-yaml.js';
import { isWorkflowFile } from '../paths.js';
import { hasDockerSocketMount, hasPrivilegedDockerRun, isBroadWritePermission, isMutableActionRef, isWritePermissionScope, referencesExternalRequest, referencesPullRequestHead, referencesShellVariable } from './workflow-rules.js';
// Structural workflow analysis. Complements the per-line detector in
// workflow-permissions.ts: this pass parses the YAML AST so it can reason
// about scope (workflow / job / step), permission precedence, and the
// effective env-secret variables visible inside each step's `run:` text —
// things a line-regex can't get right without context.
//
// Findings are only emitted when their YAML span overlaps an added line so
// the detector stays diff-scoped, matching the rest of CapabilityEcho.
export function detectWorkflowStructure(lines, newFileContents = {}) {
    const findings = [];
    const addedByFile = groupAddedLinesByFile(lines);
    for (const [file, content] of Object.entries(newFileContents)) {
        if (!isWorkflowFile(file) || !content.trim()) {
            continue;
        }
        const parsed = parseWorkflow(content);
        if (!parsed) {
            continue;
        }
        const addedSet = addedByFile.get(file) ?? new Set();
        findings.push(...analyseWorkflow(file, parsed.doc.contents, parsed.lc, addedSet));
    }
    return findings;
}
function groupAddedLinesByFile(lines) {
    const byFile = new Map();
    for (const line of lines) {
        if (!isWorkflowFile(line.file)) {
            continue;
        }
        const set = byFile.get(line.file) ?? new Set();
        set.add(line.line);
        byFile.set(line.file, set);
    }
    return byFile;
}
function analyseWorkflow(file, root, lc, added) {
    if (!root || !isMap(root)) {
        return [];
    }
    const findings = [];
    // Workflow-level `permissions:` apply to every job. Distinguish from
    // job-level because the blast radius is broader.
    const wfPermissionsPair = pairByKey(root, 'permissions');
    if (wfPermissionsPair) {
        const span = spanOfNode(wfPermissionsPair.value, lc);
        if (spanOverlapsAddedLines(span, added)) {
            findings.push(...permissionFindings(file, wfPermissionsPair, lc, 'workflow'));
        }
    }
    // Workflow-level `on:` — detect pull_request_target structurally so a
    // commented-out trigger no longer fires.
    const onPair = pairByKey(root, 'on');
    if (onPair && hasOnPullRequestTarget(onPair.value)) {
        const triggerLine = locatePullRequestTargetLine(onPair.value, lc);
        if (triggerLine !== undefined && added.has(triggerLine)) {
            findings.push({
                kind: 'capability_echo.workflow_pull_request_target',
                surface: 'workflow',
                severity: 'high',
                file,
                line: triggerLine,
                subject: 'GitHub Actions pull_request_target trigger',
                message: 'Workflow runs on pull_request_target, which can expose elevated token or secret context to PR-triggered automation.',
                recommendation: 'Use pull_request unless elevated base-repository context is required; never run untrusted PR code with pull_request_target privileges.'
            });
        }
    }
    const hasPullRequestTarget = onPair ? hasOnPullRequestTarget(onPair.value) : false;
    // Workflow-level env: collect names whose value derives from `secrets.*`.
    const workflowSecretEnv = collectSecretEnv(pairByKey(root, 'env')?.value);
    const jobsPair = pairByKey(root, 'jobs');
    if (!jobsPair || !isMap(jobsPair.value)) {
        return findings;
    }
    for (const jobPair of jobsPair.value.items) {
        if (!isMap(jobPair.value)) {
            continue;
        }
        const jobMap = jobPair.value;
        const jobName = scalarKey(jobPair) ?? 'job';
        // Job-level permissions.
        const jobPermissions = pairByKey(jobMap, 'permissions');
        if (jobPermissions) {
            const span = spanOfNode(jobPermissions.value, lc);
            if (spanOverlapsAddedLines(span, added)) {
                findings.push(...permissionFindings(file, jobPermissions, lc, 'job', jobName));
            }
        }
        // runs-on: structurally aware of list and scalar forms.
        const runsOnPair = pairByKey(jobMap, 'runs-on');
        if (runsOnPair && referencesSelfHosted(runsOnPair.value)) {
            const span = spanOfNode(runsOnPair.value, lc);
            if (spanOverlapsAddedLines(span, added)) {
                const line = lineOfNode(runsOnPair.value, lc);
                findings.push({
                    kind: 'capability_echo.workflow_self_hosted_runner',
                    surface: 'workflow',
                    severity: 'high',
                    file,
                    line,
                    subject: 'GitHub Actions self-hosted runner',
                    message: `Job "${jobName}" runs on a self-hosted runner, which can expand PR-triggered automation into private infrastructure.`,
                    recommendation: 'Use GitHub-hosted runners for untrusted PR code, or isolate self-hosted runners with strict labels, permissions, and cleanup.'
                });
            }
        }
        // secrets: inherit (used when calling reusable workflows).
        const secretsPair = pairByKey(jobMap, 'secrets');
        if (secretsPair && scalarValue(secretsPair.value) === 'inherit') {
            const line = lineOfNode(secretsPair, lc);
            if (line !== undefined && added.has(line)) {
                findings.push({
                    kind: 'capability_echo.workflow_secrets_inherit',
                    surface: 'workflow',
                    severity: 'high',
                    file,
                    line,
                    subject: 'GitHub Actions inherited secrets',
                    message: `Job "${jobName}" passes all caller secrets to a reusable workflow.`,
                    recommendation: 'Pass only explicit secrets required by the reusable workflow.'
                });
            }
        }
        const jobSecretEnv = collectSecretEnv(pairByKey(jobMap, 'env')?.value);
        const stepsPair = pairByKey(jobMap, 'steps');
        if (!stepsPair || !isSeq(stepsPair.value)) {
            continue;
        }
        for (const step of stepsPair.value.items) {
            if (!isMap(step)) {
                continue;
            }
            findings.push(...analyseStep(file, step, lc, added, jobName, workflowSecretEnv, jobSecretEnv, hasPullRequestTarget));
        }
    }
    return findings;
}
function analyseStep(file, step, lc, added, jobName, workflowSecretEnv, jobSecretEnv, hasPullRequestTarget) {
    const findings = [];
    // Mutable action references.
    const usesPair = pairByKey(step, 'uses');
    const usesValue = scalarValue(usesPair?.value);
    if (usesValue && isMutableActionRef(usesValue)) {
        const line = lineOfNode(usesPair, lc);
        if (line !== undefined && added.has(line)) {
            findings.push({
                kind: 'capability_echo.workflow_mutable_action_ref',
                surface: 'workflow',
                severity: 'medium',
                file,
                line,
                subject: 'GitHub Actions mutable action reference',
                message: `Step uses "${usesValue}", a mutable remote action reference.`,
                recommendation: 'Pin third-party actions to a reviewed commit SHA before merge.'
            });
        }
    }
    // PR-head checkout under pull_request_target.
    if (hasPullRequestTarget) {
        const withPair = pairByKey(step, 'with');
        if (withPair && isMap(withPair.value)) {
            for (const param of withPair.value.items) {
                const value = scalarValue(param.value);
                if (typeof value === 'string' && referencesPullRequestHead(value)) {
                    const line = lineOfNode(param, lc);
                    if (line !== undefined && added.has(line)) {
                        findings.push({
                            kind: 'capability_echo.workflow_pr_head_checkout_on_target',
                            surface: 'workflow',
                            severity: 'high',
                            file,
                            line,
                            subject: 'GitHub Actions PR-head reference under pull_request_target',
                            message: 'Workflow under pull_request_target references the pull request head (SHA, ref, or repo), which can let untrusted PR code run with the elevated token context.',
                            recommendation: 'Use pull_request for untrusted PR code, or avoid referencing PR head SHA/ref/repo under pull_request_target.'
                        });
                    }
                }
            }
        }
    }
    // run: text. Use the parsed scalar value so multi-line `run: |` blocks are
    // joined correctly. Line attribution still points at the run: key.
    const runPair = pairByKey(step, 'run');
    const runText = scalarValue(runPair?.value);
    if (runText !== undefined) {
        const span = spanOfNode(runPair?.value, lc);
        if (spanOverlapsAddedLines(span, added)) {
            const line = lineOfNode(runPair, lc);
            const stepSecretEnv = collectSecretEnv(pairByKey(step, 'env')?.value);
            const effectiveSecretEnv = new Set([...workflowSecretEnv, ...jobSecretEnv, ...stepSecretEnv]);
            const hasExternalRequest = referencesExternalRequest(runText);
            const referencesStepEnvSecret = [...effectiveSecretEnv].some((name) => referencesShellVariable(runText, name));
            const referencesInlineSecret = /\$\{\{\s*secrets\./i.test(runText);
            if (hasExternalRequest && (referencesStepEnvSecret || referencesInlineSecret)) {
                findings.push({
                    kind: 'capability_echo.workflow_secret_exfil_pattern',
                    surface: 'workflow',
                    severity: 'high',
                    file,
                    line,
                    subject: `Workflow secret exfiltration pattern (${jobName})`,
                    message: 'Step run command combines secrets or env values with an external request.',
                    recommendation: 'Review whether secrets could leave the runner through this step.'
                });
            }
            if (hasDockerSocketMount(runText)) {
                findings.push({
                    kind: 'capability_echo.workflow_docker_socket_mount',
                    surface: 'workflow',
                    severity: 'critical',
                    file,
                    line,
                    subject: 'Workflow Docker socket mount',
                    message: 'Step mounts the host Docker socket, which can grant control over the runner host.',
                    recommendation: 'Avoid Docker socket mounts in CI unless the job is isolated and the image/commands are trusted.'
                });
            }
            if (hasPrivilegedDockerRun(runText)) {
                findings.push({
                    kind: 'capability_echo.workflow_privileged_container',
                    surface: 'workflow',
                    severity: 'high',
                    file,
                    line,
                    subject: 'Workflow privileged container',
                    message: 'Step runs a privileged container, expanding kernel and device-level access in CI.',
                    recommendation: 'Use the narrowest container privileges required, and avoid privileged mode for agent-run code.'
                });
            }
        }
    }
    return findings;
}
function permissionFindings(file, pair, lc, scope, jobName) {
    const findings = [];
    const value = pair.value;
    // Top-level grant: `permissions: write-all` / `permissions: write`.
    const scalar = scalarValue(value);
    if (scalar && isBroadWritePermission(scalar)) {
        const line = lineOfNode(pair, lc);
        findings.push({
            kind: scope === 'workflow'
                ? 'capability_echo.workflow_workflow_level_write_permission'
                : 'capability_echo.workflow_permission_write',
            surface: 'workflow',
            severity: 'high',
            file,
            line,
            subject: scope === 'workflow'
                ? 'GitHub Actions workflow-level broad write permission'
                : `GitHub Actions job-level broad write permission (${jobName})`,
            message: scope === 'workflow'
                ? 'Workflow grants broad write/admin permissions at the workflow level — applies to every job.'
                : 'Workflow grants broad write or admin permissions for a job.',
            recommendation: 'Prefer explicit per-resource permissions instead of top-level write/admin.'
        });
        return findings;
    }
    if (!isMap(value)) {
        return findings;
    }
    for (const perm of value.items) {
        const key = scalarKey(perm);
        const val = scalarValue(perm.value);
        if (!key || !val) {
            continue;
        }
        if (!isWritePermissionScope(key)) {
            continue;
        }
        if (val.toLowerCase() !== 'write') {
            continue;
        }
        const line = lineOfNode(perm, lc);
        findings.push({
            kind: scope === 'workflow'
                ? 'capability_echo.workflow_workflow_level_write_permission'
                : 'capability_echo.workflow_permission_write',
            surface: 'workflow',
            severity: 'high',
            file,
            line,
            subject: scope === 'workflow'
                ? `GitHub Actions workflow-level write permission (${key})`
                : `GitHub Actions write permission (${key}, job ${jobName})`,
            message: scope === 'workflow'
                ? `Workflow grants ${key}:write at the workflow level — applies to every job.`
                : `Workflow grants ${key}:write to job ${jobName}.`,
            recommendation: 'Use the narrowest permission scope required for this job.'
        });
    }
    return findings;
}
function collectSecretEnv(value) {
    const out = new Set();
    if (!value || !isMap(value)) {
        return out;
    }
    for (const item of value.items) {
        const name = scalarKey(item);
        const raw = scalarValue(item.value);
        if (!name || !raw) {
            continue;
        }
        if (/\$\{\{\s*secrets\./i.test(raw)) {
            out.add(name);
        }
    }
    return out;
}
function hasOnPullRequestTarget(value) {
    if (!value) {
        return false;
    }
    const scalar = scalarValue(value);
    if (scalar === 'pull_request_target') {
        return true;
    }
    if (isSeq(value)) {
        for (const item of value.items) {
            if (scalarValue(item) === 'pull_request_target') {
                return true;
            }
        }
    }
    if (isMap(value)) {
        for (const item of value.items) {
            if (scalarKey(item) === 'pull_request_target') {
                return true;
            }
        }
    }
    return false;
}
function locatePullRequestTargetLine(value, lc) {
    if (!value) {
        return undefined;
    }
    if (isMap(value)) {
        for (const item of value.items) {
            if (scalarKey(item) === 'pull_request_target') {
                return lineOfNode(item, lc);
            }
        }
    }
    if (isSeq(value)) {
        for (const item of value.items) {
            if (scalarValue(item) === 'pull_request_target') {
                return lineOfNode(item, lc);
            }
        }
    }
    // Scalar form: `on: pull_request_target`.
    return lineOfNode(value, lc);
}
function referencesSelfHosted(value) {
    const scalar = scalarValue(value);
    if (typeof scalar === 'string' && /\bself-hosted\b/i.test(scalar)) {
        return true;
    }
    if (isSeq(value)) {
        for (const item of value.items) {
            const itemValue = scalarValue(item);
            if (typeof itemValue === 'string' && /\bself-hosted\b/i.test(itemValue)) {
                return true;
            }
        }
    }
    return false;
}
function pairByKey(map, key) {
    for (const pair of map.items) {
        if (scalarKey(pair) === key) {
            return pair;
        }
    }
    return undefined;
}
function scalarKey(pair) {
    const k = pair.key;
    if (!k) {
        return undefined;
    }
    if (typeof k.value === 'string') {
        return k.value;
    }
    return undefined;
}
