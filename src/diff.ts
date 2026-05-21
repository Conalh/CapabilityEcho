import { detectJsCapability } from './detectors/js-capability.js';
import { detectPackageScripts } from './detectors/package-scripts.js';
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

  const packageFindings =
    options.mode === 'directories'
      ? await detectPackageScripts({ mode: 'directories', oldRoot: options.oldRoot, newRoot: options.newRoot })
      : await detectPackageScripts({ mode: 'git', repo: options.repo, base: options.base, head: options.head });

  const findings = [
    ...detectWorkflowPermissions(context.addedLines),
    ...detectJsCapability(context.addedLines),
    ...packageFindings
  ];

  return createReport(findings, context);
}
