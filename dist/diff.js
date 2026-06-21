import { detectDockerfileCapability } from './detectors/dockerfile-capability.js';
import { detectJsCapability } from './detectors/js-capability.js';
import { detectNpmLockfile } from './detectors/npm-lockfile.js';
import { detectPackageDeps } from './detectors/package-deps.js';
import { detectPackageScripts } from './detectors/package-scripts.js';
import { detectPyCapability } from './detectors/py-capability.js';
import { detectPythonDeps } from './detectors/python-deps.js';
import { detectShellCapability } from './detectors/shell-capability.js';
import { detectWorkflowPermissions } from './detectors/workflow-permissions.js';
import { detectWorkflowStructure } from './detectors/workflow-structure.js';
import { applyExceptionBaseline } from './exceptions.js';
import { collectDirectoryDiff, collectGitDiff } from './git-diff.js';
import { createReport } from './report.js';
export async function runCapabilityDiff(options) {
    const context = options.mode === 'directories'
        ? await collectDirectoryDiff(options.oldRoot, options.newRoot)
        : await collectGitDiff(options.repo, options.base, options.head);
    const packageMode = options.mode === 'directories'
        ? ({ mode: 'directories', oldRoot: options.oldRoot, newRoot: options.newRoot })
        : ({ mode: 'git', repo: options.repo, base: options.base, head: options.head });
    const [scriptFindings, depFindings, pythonDepFindings, lockfileFindings] = await Promise.all([
        detectPackageScripts(packageMode),
        detectPackageDeps(packageMode),
        detectPythonDeps(packageMode),
        detectNpmLockfile(packageMode)
    ]);
    const findings = dedupeFindings([
        ...detectWorkflowStructure(context.addedLines, context.newFileContents),
        ...detectWorkflowPermissions(context.addedLines, context.newFileContents),
        ...detectDockerfileCapability(context.addedLines),
        ...detectJsCapability(context.addedLines, context.newFileContents),
        ...detectPyCapability(context.addedLines, context.newFileContents),
        ...detectShellCapability(context.addedLines, context.newFileContents),
        ...scriptFindings,
        ...depFindings,
        ...pythonDepFindings,
        ...lockfileFindings
    ]);
    const exceptionResult = await applyExceptionBaseline(findings, options.mode === 'directories'
        ? { mode: 'directories', root: options.newRoot, exceptionsFile: options.exceptionsFile }
        : { mode: 'git', repo: options.repo, head: options.head, exceptionsFile: options.exceptionsFile });
    const finalContext = {
        ...context,
        analysisIncomplete: context.analysisIncomplete || exceptionResult.diagnostics.length > 0,
        analysisDiagnostics: [...context.analysisDiagnostics, ...exceptionResult.diagnostics]
    };
    return createReport(exceptionResult.findings, finalContext, {
        suppressedFindingCount: exceptionResult.suppressedFindingCount,
        expiredExceptionCount: exceptionResult.expiredExceptionCount
    });
}
// Two-stage dedup:
//   1. Drop exact-duplicate (kind, file, line) entries — the structural and
//      per-line workflow detectors can land on the same kind/line.
//   2. When a more-specific structural kind is present at a (file, line),
//      drop the less-specific kinds it supersedes at the same location.
//      This hides the per-line generic permission finding when the
//      structural workflow-level one carries strictly richer context.
const SUPERSEDES = {
    'capability_echo.workflow_workflow_level_write_permission': ['capability_echo.workflow_permission_write']
};
function dedupeFindings(findings) {
    const kindsByLocation = new Map();
    for (const finding of findings) {
        const key = `${finding.file}:${finding.line ?? ''}`;
        const set = kindsByLocation.get(key) ?? new Set();
        set.add(finding.kind);
        kindsByLocation.set(key, set);
    }
    const suppressByLocation = new Map();
    for (const [key, kinds] of kindsByLocation.entries()) {
        const set = new Set();
        for (const kind of kinds) {
            const targets = SUPERSEDES[kind];
            if (!targets) {
                continue;
            }
            for (const target of targets) {
                set.add(target);
            }
        }
        suppressByLocation.set(key, set);
    }
    const seen = new Set();
    const out = [];
    for (const finding of findings) {
        const dedupKey = `${finding.kind} ${finding.file} ${finding.line ?? ''}`;
        if (seen.has(dedupKey)) {
            continue;
        }
        const locationKey = `${finding.file}:${finding.line ?? ''}`;
        if (suppressByLocation.get(locationKey)?.has(finding.kind)) {
            continue;
        }
        seen.add(dedupKey);
        out.push(finding);
    }
    return out;
}
