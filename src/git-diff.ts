import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { isValidGitRef, resolveWithinRoot, withinByteCap } from 'agent-gov-core';
import { isScannable, surfaceForPath } from './paths.js';
import type { AddedLine, DiffContext, FindingSurface } from './types.js';

const execFileAsync = promisify(execFile);
const SURFACE_ORDER: FindingSurface[] = ['source', 'package', 'workflow', 'container'];

export class GitDiffSetupError extends Error {
  constructor(
    message: string,
    public readonly base: string,
    public readonly head: string
  ) {
    super(message);
    this.name = 'GitDiffSetupError';
  }
}

export async function collectDirectoryDiff(oldRoot: string, newRoot: string): Promise<DiffContext> {
  const changedFiles = await listScannableFiles(newRoot);
  const addedLines: AddedLine[] = [];
  const changedScannableFiles = new Set<string>();
  const newFileContents: Record<string, string> = {};

  for (const file of changedFiles) {
    const oldPath = resolveWithinRoot(oldRoot, file);
    const newPath = resolveWithinRoot(newRoot, file);
    if (oldPath === null || newPath === null) {
      // listScannableFiles only yields paths it walked itself, so a null
      // here means a crafted entry tried to escape the root — skip it
      // rather than read outside the scanned tree.
      continue;
    }
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
    } catch {
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

export async function collectGitDiff(repo: string, base: string, head: string): Promise<DiffContext> {
  const baseExists = await gitRefExists(repo, base);
  const headExists = await gitRefExists(repo, head);
  if (!baseExists || !headExists) {
    throw new GitDiffSetupError(
      `CapabilityEcho could not compare base '${base}' and head '${head}'.`,
      base,
      head
    );
  }

  const changedFiles = await listGitChangedFiles(repo, base, head);
  const scannableFiles = changedFiles.filter(isScannable);
  if (scannableFiles.length === 0) {
    return { addedLines: [], changedFileCount: 0, scannedSurfaces: [], newFileContents: {} };
  }

  const { stdout } = await execFileAsync(
    'git',
    ['-C', repo, 'diff', '-U0', `${base}..${head}`, '--', ...scannableFiles],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
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

export function parseUnifiedDiff(patch: string, relativeFile?: string): AddedLine[] {
  const results: AddedLine[] = [];
  let currentFile = '';
  let newLineNum = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      if (rawPath.startsWith('b/')) {
        currentFile = rawPath.slice(2);
      } else if (rawPath === '/dev/null') {
        currentFile = '';
      } else {
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

async function listScannableFiles(root: string, current = ''): Promise<string[]> {
  const entries = await readdir(join(root, current), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    // Never follow symlinks: in directory mode the tree is untrusted, and a
    // symlinked entry could point outside the scanned root (e.g. /etc/passwd
    // or a sibling checkout), leaking its contents into finding evidence.
    if (entry.isSymbolicLink()) {
      continue;
    }

    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listScannableFiles(root, relativePath)));
      continue;
    }

    if (isScannable(relativePath)) {
      // Skip files over the shared 10 MiB input cap so an outsized file
      // in an untrusted tree can't exhaust memory when read and scanned.
      const stats = await stat(join(root, relativePath));
      if (withinByteCap(stats.size)) {
        files.push(relativePath.replace(/\\/g, '/'));
      }
    }
  }

  return files;
}

export async function listGitChangedFiles(repo: string, base: string, head: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repo, 'diff', '--name-only', `${base}..${head}`],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, '/'));
}

async function runGitNoIndexDiff(oldPath: string, newPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-index', '-U0', oldPath, newPath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    if (isExecError(error) && typeof error.stdout === 'string') {
      return error.stdout;
    }

    return '';
  }
}

function allLinesAsAdded(file: string, content: string): AddedLine[] {
  const lines = content.split(/\r?\n/);
  return lines.map((lineContent, index) => ({
    file: file.replace(/\\/g, '/'),
    line: index + 1,
    content: lineContent
  }));
}

async function gitRefExists(repo: string, ref: string): Promise<boolean> {
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
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch (error) {
    if (isExecError(error)) {
      return false;
    }

    throw error;
  }
}

function surfacesForFiles(files: string[]): FindingSurface[] {
  const surfaces = new Set<FindingSurface>();
  for (const file of files) {
    const surface = surfaceForPath(file);
    if (surface) {
      surfaces.add(surface);
    }
  }

  return SURFACE_ORDER.filter((surface) => surfaces.has(surface));
}

function isExecError(error: unknown): error is Error & { code?: number | string; stdout?: string } {
  return error instanceof Error && 'code' in error;
}

function normalizeGitDiffPath(file: string): string {
  return file
    .replace(/\\/g, '/')
    .replace(/^[a-z]:\//i, '')
    .replace(/^b\//, '');
}

export async function readFileAtGitRef(repo: string, ref: string, relativePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'show', `${ref}:${relativePath}`], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    if (isExecError(error)) {
      return null;
    }

    throw error;
  }
}

async function readChangedFilesAtRef(repo: string, ref: string, files: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const content = await readFileAtGitRef(repo, ref, file);
      return content === null ? undefined : ([file, content] as const);
    })
  );

  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== undefined));
}

export async function listPackageJsonFiles(root: string, current = ''): Promise<string[]> {
  const entries = await readdir(join(root, current), { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    // See listScannableFiles: do not follow symlinks out of an untrusted tree.
    if (entry.isSymbolicLink()) {
      continue;
    }

    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listPackageJsonFiles(root, relativePath)));
      continue;
    }

    if (entry.name === 'package.json') {
      // Same input cap as listScannableFiles: never read an oversized
      // manifest from an untrusted tree.
      const stats = await stat(join(root, relativePath));
      if (withinByteCap(stats.size)) {
        files.push(relativePath.replace(/\\/g, '/'));
      }
    }
  }

  return files;
}

export function relativeFromRoots(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replace(/\\/g, '/');
}
