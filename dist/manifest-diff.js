import { listSafeFiles, readTextWithinRoot } from './discovery.js';
import { listGitChangedFiles, readFileAtGitRef } from './git-diff.js';
import { isNpmLockfile, isPackageJsonFile, isPythonManifestFile } from './paths.js';
export async function collectPackageJsonDiffs(mode) {
    return collectTextDiffs(mode, isPackageJsonFile);
}
export async function collectNpmLockfileDiffs(mode) {
    return collectTextDiffs(mode, isNpmLockfile);
}
export async function collectPythonManifestDiffs(mode) {
    return collectTextDiffs(mode, isPythonManifestFile, ['node_modules', '.git', '.venv', 'venv']);
}
async function collectTextDiffs(mode, includeFile, excludedDirs) {
    const files = mode.mode === 'directories'
        ? (await listSafeFiles(mode.newRoot, { includeFile, ...(excludedDirs ? { excludedDirs } : {}) })).files
        : (await listGitChangedFiles(mode.repo, mode.base, mode.head)).filter(includeFile);
    return Promise.all(files.map(async (file) => ({
        file,
        oldText: await readTextAt(mode, file, 'old'),
        newText: await readTextAt(mode, file, 'new')
    })));
}
async function readTextAt(mode, file, side) {
    if (mode.mode === 'directories') {
        const root = side === 'old' ? mode.oldRoot : mode.newRoot;
        return (await readTextWithinRoot(root, file)).text;
    }
    const ref = side === 'old' ? mode.base : mode.head;
    return (await readFileAtGitRef(mode.repo, ref, file)) ?? '';
}
