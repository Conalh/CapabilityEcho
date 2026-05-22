import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { isScannable, surfaceForPath } from './paths.js';
const execFileAsync = promisify(execFile);
const SURFACE_ORDER = ['source', 'package', 'workflow', 'container'];
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
    const changedFiles = await listScannableFiles(newRoot);
    const addedLines = [];
    const changedScannableFiles = new Set();
    const newFileContents = {};
    for (const file of changedFiles) {
        const oldPath = join(oldRoot, file);
        const newPath = join(newRoot, file);
        const newContent = await readFile(newPath, 'utf8');
        const patch = await runGitNoIndexDiff(oldPath, newPath);
        if (patch.trim()) {
            changedScannableFiles.add(file);
            newFileContents[file] = newContent;
            addedLines.push(...parseUnifiedDiff(patch, file));
            continue;
        }
        let oldContent = '';
        try {
            oldContent = await readFile(oldPath, 'utf8');
        }
        catch {
            oldContent = '';
        }
        if (oldContent === newContent) {
            continue;
        }
        changedScannableFiles.add(file);
        newFileContents[file] = newContent;
        if (!oldContent) {
            addedLines.push(...allLinesAsAdded(file, newContent));
        }
    }
    return {
        addedLines,
        changedFileCount: changedScannableFiles.size,
        scannedSurfaces: surfacesForFiles([...changedScannableFiles]),
        newFileContents
    };
}
export async function collectGitDiff(repo, base, head) {
    const baseExists = await gitRefExists(repo, base);
    const headExists = await gitRefExists(repo, head);
    if (!baseExists || !headExists) {
        throw new GitDiffSetupError(`CapabilityEcho could not compare base '${base}' and head '${head}'.`, base, head);
    }
    const changedFiles = await listGitChangedFiles(repo, base, head);
    const scannableFiles = changedFiles.filter(isScannable);
    if (scannableFiles.length === 0) {
        return { addedLines: [], changedFileCount: 0, scannedSurfaces: [], newFileContents: {} };
    }
    const { stdout } = await execFileAsync('git', ['-C', repo, 'diff', '-U0', `${base}..${head}`, '--', ...scannableFiles], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const newFileContents = await readChangedFilesAtRef(repo, head, scannableFiles);
    return {
        addedLines: parseUnifiedDiff(stdout).map((line) => ({
            ...line,
            file: normalizeGitDiffPath(line.file)
        })),
        changedFileCount: scannableFiles.length,
        scannedSurfaces: surfacesForFiles(scannableFiles),
        newFileContents
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
async function listScannableFiles(root, current = '') {
    const entries = await readdir(join(root, current), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
        }
        const relativePath = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            files.push(...(await listScannableFiles(root, relativePath)));
            continue;
        }
        if (isScannable(relativePath)) {
            files.push(relativePath.replace(/\\/g, '/'));
        }
    }
    return files;
}
export async function listGitChangedFiles(repo, base, head) {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'diff', '--name-only', `${base}..${head}`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/\\/g, '/'));
}
async function runGitNoIndexDiff(oldPath, newPath) {
    try {
        const { stdout } = await execFileAsync('git', ['diff', '--no-index', '-U0', oldPath, newPath], {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
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
    try {
        await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
        return true;
    }
    catch (error) {
        if (isExecError(error)) {
            return false;
        }
        throw error;
    }
}
function surfacesForFiles(files) {
    const surfaces = new Set();
    for (const file of files) {
        const surface = surfaceForPath(file);
        if (surface) {
            surfaces.add(surface);
        }
    }
    return SURFACE_ORDER.filter((surface) => surfaces.has(surface));
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
    try {
        const { stdout } = await execFileAsync('git', ['-C', repo, 'show', `${ref}:${relativePath}`], {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
        return stdout;
    }
    catch (error) {
        if (isExecError(error)) {
            return null;
        }
        throw error;
    }
}
async function readChangedFilesAtRef(repo, ref, files) {
    const entries = await Promise.all(files.map(async (file) => {
        const content = await readFileAtGitRef(repo, ref, file);
        return content === null ? undefined : [file, content];
    }));
    return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}
export async function listPackageJsonFiles(root, current = '') {
    const entries = await readdir(join(root, current), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
        }
        const relativePath = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            files.push(...(await listPackageJsonFiles(root, relativePath)));
            continue;
        }
        if (entry.name === 'package.json') {
            files.push(relativePath.replace(/\\/g, '/'));
        }
    }
    return files;
}
export function relativeFromRoots(root, absolutePath) {
    return relative(root, absolutePath).replace(/\\/g, '/');
}
