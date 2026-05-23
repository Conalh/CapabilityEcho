import { detectDockerfileCapability } from './detectors/dockerfile-capability.js';
import { detectJsCapability } from './detectors/js-capability.js';
import { detectNpmLockfile } from './detectors/npm-lockfile.js';
import { detectPackageDeps } from './detectors/package-deps.js';
import { detectPackageScripts } from './detectors/package-scripts.js';
import { detectPyCapability } from './detectors/py-capability.js';
import { detectPythonDeps } from './detectors/python-deps.js';
import { detectShellCapability } from './detectors/shell-capability.js';
import { detectWorkflowPermissions } from './detectors/workflow-permissions.js';
import { collectDirectoryDiff, collectGitDiff } from './git-diff.js';
import { createReport, type EchoReport } from './report.js';

export type DiffMode =
  | { mode: 'directories'; oldRoot: string; newRoot: string }
  | { mode: 'git'; repo: string; base: string; head: string };

export async function runCapabilityDiff(options: DiffMode): Promise<EchoReport> {
  const context =
    options.mode === 'directories'
      ? await collectDirectoryDiff(options.oldRoot, options.newRoot)
      : await collectGitDiff(options.repo, options.base, options.head);

  const packageMode =
    options.mode === 'directories'
      ? ({ mode: 'directories' as const, oldRoot: options.oldRoot, newRoot: options.newRoot })
      : ({ mode: 'git' as const, repo: options.repo, base: options.base, head: options.head });

  const [scriptFindings, depFindings, pythonDepFindings, lockfileFindings] = await Promise.all([
    detectPackageScripts(packageMode),
    detectPackageDeps(packageMode),
    detectPythonDeps(packageMode),
    detectNpmLockfile(packageMode)
  ]);

  const findings = [
    ...detectWorkflowPermissions(context.addedLines, context.newFileContents),
    ...detectDockerfileCapability(context.addedLines),
    ...detectJsCapability(context.addedLines, context.newFileContents),
    ...detectPyCapability(context.addedLines, context.newFileContents),
    ...detectShellCapability(context.addedLines),
    ...scriptFindings,
    ...depFindings,
    ...pythonDepFindings,
    ...lockfileFindings
  ];

  return createReport(findings, context);
}
