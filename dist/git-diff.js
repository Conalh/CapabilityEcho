import { execFile } from 'node:child_process';
import { relative } from 'node:path';
import { promisify } from 'node:util';
import { isValidGitRef, resolveWithinRoot } from 'agent-gov-core';
import { listSafeFiles, readTextWithinRoot } from './discovery.js';
import { hasShellShebang, isPackageJsonFile, isPotentialShebangScript, isScannable, surfaceForPath } from './paths.js';
const execFileAsync = promisify(execFile);
const SURFACE_ORDER = ['source', 'package', 'workflow', 'container'];
const GIT_DIFF_MAX_BUFFER = 20 * 1024 * 1024;
const GIT_SHOW_MAX_BUFFER = 10 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_SHOW_CONCURRENCY = 8;
const MAX_GIT_CHANGED_FILES = 10_000;
export class GitDiffSetupError extends Error {
    base;
    head;
    constructor(message, base, head) {
        super(message);
        this.base = base;
        this.head = head;
        this.name = 'GitDiffSetupError';
    }
}
export async function collectDirectoryDiff(oldRoot, newRoot) {
    const discovery = await listSafeFiles(newRoot, { includeFile: isScannableOrPotentialShebangScript });
    const changedFiles = discovery.files;
    const diagnostics = [...discovery.diagnostics];
    const addedLines = [];
    const changedScannableFiles = new Set();
    const newFileContents = {};
    for (const file of changedFiles) {
        const oldPath = resolveWithinRoot(oldRoot, file);
        const newPath = resolveWithinRoot(newRoot, file);
        if (oldPath === null || newPath === null) {
            diagnostics.push({
                kind: 'skipped_path_escape',
                file,
                message: `Skipped ${file}: resolved path escapes the scan root.`
            });
            continue;
        }
        const newRead = await readTextWithinRoot(newRoot, file);
        if (newRead.diagnostic) {
            diagnostics.push(newRead.diagnostic);
            continue;
        }
        const oldRead = await readTextWithinRoot(oldRoot, file);
        if (oldRead.diagnostic) {
            diagnostics.push(oldRead.diagnostic);
        }
        const newContent = newRead.text;
        if (!isScannable(file) && !hasShellShebang(newContent)) {
            continue;
        }
        const patch = oldRead.diagnostic ? '' : await runGitNoIndexDiff(oldPath, newPath);
        if (patch.trim()) {
            changedScannableFiles.add(file);
            newFileContents[file] = newContent;
            addedLines.push(...parseUnifiedDiff(patch, file));
            continue;
        }
        if (oldRead.text === newContent) {
            continue;
        }
        changedScannableFiles.add(file);
        newFileContents[file] = newContent;
        if (!oldRead.text) {
            addedLines.push(...allLinesAsAdded(file, newContent));
        }
    }
    return {
        addedLines,
        changedFileCount: changedScannableFiles.size,
        scannedSurfaces: surfacesForFiles([...changedScannableFiles], newFileContents),
        newFileContents,
        analysisIncomplete: diagnostics.length > 0,
        analysisDiagnostics: diagnostics
    };
}
export async function collectGitDiff(repo, base, head) {
    const baseExists = await gitRefExists(repo, base);
    const headExists = await gitRefExists(repo, head);
    if (!baseExists || !headExists) {
        throw new GitDiffSetupError(`CapabilityEcho could not compare base '${base}' and head '${head}'.`, base, head);
    }
    const changedFileDiscovery = await collectGitChangedFiles(repo, base, head);
    const changedFiles = changedFileDiscovery.files;
    const diagnostics = [...changedFileDiscovery.diagnostics];
    const pathScannableFiles = changedFiles.filter(isScannable);
    const shebangCandidates = changedFiles.filter((file) => !isScannable(file) && isPotentialShebangScript(file));
    const shebangReadResult = await readChangedFilesAtRef(repo, head, shebangCandidates);
    diagnostics.push(...shebangReadResult.diagnostics);
    const shebangScannableFiles = Object.entries(shebangReadResult.contents)
        .filter(([, content]) => hasShellShebang(content))
        .map(([file]) => file);
    const scannableFiles = [...new Set([...pathScannableFiles, ...shebangScannableFiles])];
    if (scannableFiles.length === 0) {
        return {
            addedLines: [],
            changedFileCount: 0,
            scannedSurfaces: [],
            newFileContents: {},
            analysisIncomplete: diagnostics.length > 0,
            analysisDiagnostics: diagnostics
        };
    }
    const { stdout } = await execFileAsync('git', ['-C', repo, '-c', 'core.quotePath=false', 'diff', '-U0', `${base}..${head}`, '--', ...scannableFiles], { encoding: 'utf8', maxBuffer: GIT_DIFF_MAX_BUFFER, timeout: GIT_COMMAND_TIMEOUT_MS });
    const readResult = await readChangedFilesAtRef(repo, head, scannableFiles);
    diagnostics.push(...readResult.diagnostics);
    return {
        addedLines: parseUnifiedDiff(stdout).map((line) => ({
            ...line,
            file: normalizeGitDiffPath(line.file)
        })),
        changedFileCount: scannableFiles.length,
        scannedSurfaces: surfacesForFiles(scannableFiles, readResult.contents),
        newFileContents: readResult.contents,
        analysisIncomplete: diagnostics.length > 0,
        analysisDiagnostics: diagnostics
    };
}
export function parseUnifiedDiff(patch, relativeFile) {
    const results = [];
    let currentFile = '';
    let newLineNum = 0;
    for (const line of patch.split(/\r?\n/)) {
        if (line.startsWith('+++ ')) {
            const rawPath = line.slice(4).trim();
            if (rawPath.startsWith('b/')) {
                currentFile = rawPath.slice(2);
            }
            else if (rawPath === '/dev/null') {
                currentFile = '';
            }
            else {
                currentFile = rawPath;
            }
            continue;
        }
        if (line.startsWith('@@')) {
            const match = line.match(/\+(\d+)(?:,(\d+))?/);
            newLineNum = match ? Number.parseInt(match[1], 10) : 0;
            continue;
        }
        if (!currentFile || currentFile === '/dev/null') {
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            results.push({
                file: (relativeFile ?? normalizeGitDiffPath(currentFile)).replace(/\\/g, '/'),
                line: newLineNum,
                content: line.slice(1)
            });
            newLineNum += 1;
            continue;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
            continue;
        }
        if (line.startsWith(' ') || line.startsWith('\\')) {
            newLineNum += 1;
        }
    }
    return results;
}
export async function listGitChangedFiles(repo, base, head) {
    return (await collectGitChangedFiles(repo, base, head)).files;
}
async function collectGitChangedFiles(repo, base, head) {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'diff', '--name-only', '-z', `${base}..${head}`], { encoding: 'buffer', maxBuffer: GIT_SHOW_MAX_BUFFER, timeout: GIT_COMMAND_TIMEOUT_MS });
    const files = stdout
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((line) => line.replace(/\\/g, '/'))
        .sort();
    const diagnostics = [];
    if (files.length > MAX_GIT_CHANGED_FILES) {
        diagnostics.push({
            kind: 'skipped_file_count_limit',
            message: `Stopped git changed-file discovery after ${MAX_GIT_CHANGED_FILES} files.`
        });
    }
    return { files: files.slice(0, MAX_GIT_CHANGED_FILES), diagnostics };
}
async function runGitNoIndexDiff(oldPath, newPath) {
    try {
        const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '-U0', oldPath, newPath], {
            encoding: 'utf8',
            maxBuffer: GIT_SHOW_MAX_BUFFER,
            timeout: GIT_COMMAND_TIMEOUT_MS
        });
        return stdout;
    }
    catch (error) {
        if (isExecError(error) && typeof error.stdout === 'string') {
            return error.stdout;
        }
        return '';
    }
}
function allLinesAsAdded(file, content) {
    const lines = content.split(/\r?\n/);
    return lines.map((lineContent, index) => ({
        file: file.replace(/\\/g, '/'),
        line: index + 1,
        content: lineContent
    }));
}
async function gitRefExists(repo, ref) {
    // String-level argument-injection guard, shared across the suite via
    // agent-gov-core. `execFile` blocks shell metacharacters, but git
    // re-parses a positional ref against its own option table — so a
    // `-`-leading ref (`--upload-pack=...`) is a flag-injection vector, and
    // a `:` would re-anchor the `ref:path` object selector readFileAtGitRef
    // builds. Treat an injection-vector ref as "does not exist" so the
    // value never reaches a git subprocess; collectGitDiff then surfaces a
    // clean GitDiffSetupError.
    if (!isValidGitRef(ref)) {
        return false;
    }
    try {
        await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], {
            timeout: GIT_COMMAND_TIMEOUT_MS
        });
        return true;
    }
    catch (error) {
        if (isExecError(error)) {
            return false;
        }
        throw error;
    }
}
function surfacesForFiles(files, fileContents = {}) {
    const surfaces = new Set();
    for (const file of files) {
        const surface = surfaceForPath(file) ?? (hasShellShebang(fileContents[file]) ? 'source' : undefined);
        if (surface) {
            surfaces.add(surface);
        }
    }
    return SURFACE_ORDER.filter((surface) => surfaces.has(surface));
}
function isScannableOrPotentialShebangScript(file) {
    return isScannable(file) || isPotentialShebangScript(file);
}
function isExecError(error) {
    return error instanceof Error && 'code' in error;
}
function normalizeGitDiffPath(file) {
    return file
        .replace(/\\/g, '/')
        .replace(/^[a-z]:\//i, '')
        .replace(/^b\//, '');
}
export async function readFileAtGitRef(repo, ref, relativePath) {
    const result = await readFileAtGitRefResult(repo, ref, relativePath);
    return result.content;
}
async function readFileAtGitRefResult(repo, ref, relativePath) {
    try {
        const { stdout } = await execFileAsync('git', ['-C', repo, 'show', `${ref}:${relativePath}`], {
            encoding: 'utf8',
            maxBuffer: GIT_SHOW_MAX_BUFFER,
            timeout: GIT_COMMAND_TIMEOUT_MS
        });
        return { content: stdout };
    }
    catch (error) {
        if (isExecError(error)) {
            return {
                content: null,
                diagnostic: {
                    kind: 'git_read_failed',
                    file: relativePath,
                    message: `Could not read ${relativePath} at ${ref}: ${error.message}.`
                }
            };
        }
        throw error;
    }
}
async function readChangedFilesAtRef(repo, ref, files) {
    const entries = await mapWithConcurrency(files, GIT_SHOW_CONCURRENCY, async (file) => {
        const result = await readFileAtGitRefResult(repo, ref, file);
        return result.content === null
            ? { diagnostic: result.diagnostic }
            : { entry: [file, result.content] };
    });
    const diagnostics = entries
        .map((entry) => entry.diagnostic)
        .filter((diagnostic) => diagnostic !== undefined);
    const contents = Object.fromEntries(entries
        .map((entry) => entry.entry)
        .filter((entry) => entry !== undefined));
    return { contents, diagnostics };
}
export async function listPackageJsonFiles(root) {
    return (await listSafeFiles(root, { includeFile: isPackageJsonFile })).files;
}
export function relativeFromRoots(root, absolutePath) {
    return relative(root, absolutePath).replace(/\\/g, '/');
}
async function mapWithConcurrency(items, concurrency, fn) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await fn(items[currentIndex]);
        }
    }
    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}
