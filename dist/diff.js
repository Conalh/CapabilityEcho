import { detectDockerfileCapability } from './detectors/dockerfile-capability.js';
import { detectJsCapability } from './detectors/js-capability.js';
import { detectPackageDeps } from './detectors/package-deps.js';
import { detectPackageScripts } from './detectors/package-scripts.js';
import { detectPyCapability } from './detectors/py-capability.js';
import { detectPythonDeps } from './detectors/python-deps.js';
import { detectShellCapability } from './detectors/shell-capability.js';
import { detectWorkflowPermissions } from './detectors/workflow-permissions.js';
import { collectDirectoryDiff, collectGitDiff } from './git-diff.js';
import { createReport } from './report.js';
export async function runCapabilityDiff(options) {
    const context = options.mode === 'directories'
        ? await collectDirectoryDiff(options.oldRoot, options.newRoot)
        : await collectGitDiff(options.repo, options.base, options.head);
    const packageMode = options.mode === 'directories'
        ? ({ mode: 'directories', oldRoot: options.oldRoot, newRoot: options.newRoot })
        : ({ mode: 'git', repo: options.repo, base: options.base, head: options.head });
    const [scriptFindings, depFindings, pythonDepFindings] = await Promise.all([
        detectPackageScripts(packageMode),
        detectPackageDeps(packageMode),
        detectPythonDeps(packageMode)
    ]);
    const findings = [
        ...detectWorkflowPermissions(context.addedLines, context.newFileContents),
        ...detectDockerfileCapability(context.addedLines),
        ...detectJsCapability(context.addedLines, context.newFileContents),
        ...detectPyCapability(context.addedLines, context.newFileContents),
        ...detectShellCapability(context.addedLines),
        ...scriptFindings,
        ...depFindings,
        ...pythonDepFindings
    ];
    return createReport(findings, context);
}
