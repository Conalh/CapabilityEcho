import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { isScannable } from './paths.js';
const execFileAsync = promisify(execFile);
export async function collectDirectoryDiff(oldRoot, newRoot) {
    const changedFiles = await listScannableFiles(newRoot);
    const addedLines = [];
    for (const file of changedFiles) {
        const oldPath = join(oldRoot, file);
        const newPath = join(newRoot, file);
        const patch = await runGitNoIndexDiff(oldPath, newPath);
        if (patch.trim()) {
            addedLines.push(...parseUnifiedDiff(patch, file));
            continue;
        }
        const newContent = await readFile(newPath, 'utf8');
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
        if (!oldContent) {
            addedLines.push(...allLinesAsAdded(file, newContent));
        }
    }
    return {
        addedLines,
        changedFileCount: countChangedFiles(addedLines)
    };
}
export async function collectGitDiff(repo, base, head) {
    await verifyGitRef(repo, base);
    await verifyGitRef(repo, head);
    const changedFiles = await listGitChangedFiles(repo, base, head);
    const scannableFiles = changedFiles.filter(isScannable);
    if (scannableFiles.length === 0) {
        return { addedLines: [], changedFileCount: 0 };
    }
    const { stdout } = await execFileAsync('git', ['-C', repo, 'diff', '-U0', `${base}..${head}`, '--', ...scannableFiles], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    return {
        addedLines: parseUnifiedDiff(stdout).map((line) => ({
            ...line,
            file: normalizeGitDiffPath(line.file)
        })),
        changedFileCount: scannableFiles.length
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
async function listGitChangedFiles(repo, base, head) {
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
function countChangedFiles(addedLines) {
    return new Set(addedLines.map((line) => line.file)).size;
}
async function verifyGitRef(repo, ref) {
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
}
function isExecError(error) {
    return error instanceof Error && 'code' in error;
}
function normalizeGitDiffPath(file) {
    const normalized = file.replace(/\\/g, '/');
    const markers = ['/src/', '/.github/workflows/', '/package.json'];
    for (const marker of markers) {
        const index = normalized.lastIndexOf(marker);
        if (index >= 0) {
            return normalized.slice(index + 1);
        }
    }
    if (normalized.endsWith('package.json')) {
        return 'package.json';
    }
    return normalized.replace(/^[a-z]:\//i, '').replace(/^b\//, '');
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
