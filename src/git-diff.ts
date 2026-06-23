import { execFile } from 'node:child_process';
import { relative } from 'node:path';
import { promisify } from 'node:util';
import { isValidGitRef, resolveWithinRoot } from 'agent-gov-core';
import { listSafeFiles, readTextWithinRoot } from './discovery.js';
import { hasShellShebang, isPotentialShebangScript, isScannable, surfaceForPath } from './paths.js';
import type { AddedLine, AnalysisDiagnostic, DiffContext, FindingSurface } from './types.js';

const execFileAsync = promisify(execFile);
const SURFACE_ORDER: FindingSurface[] = ['source', 'package', 'workflow', 'container'];
const GIT_DIFF_MAX_BUFFER = 20 * 1024 * 1024;
const GIT_SHOW_MAX_BUFFER = 10 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_SHOW_CONCURRENCY = 8;
const MAX_GIT_CHANGED_FILES = 10_000;

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
  const discovery = await listSafeFiles(newRoot, { includeFile: isScannableOrPotentialShebangScript });
  const changedFiles = discovery.files;
  const diagnostics: AnalysisDiagnostic[] = [...discovery.diagnostics];
  const addedLines: AddedLine[] = [];
  const changedScannableFiles = new Set<string>();
  const newFileContents: Record<string, string> = {};

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

  const changedFileDiscovery = await collectGitChangedFiles(repo, base, head);
  const changedFiles = changedFileDiscovery.files;
  const diagnostics: AnalysisDiagnostic[] = [...changedFileDiscovery.diagnostics];
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

  const { stdout } = await execFileAsync(
    'git',
    ['-C', repo, '-c', 'core.quotePath=false', 'diff', '-U0', `${base}..${head}`, '--', ...scannableFiles],
    { encoding: 'utf8', maxBuffer: GIT_DIFF_MAX_BUFFER, timeout: GIT_COMMAND_TIMEOUT_MS }
  );
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

export async function listGitChangedFiles(repo: string, base: string, head: string): Promise<string[]> {
  return (await collectGitChangedFiles(repo, base, head)).files;
}

async function collectGitChangedFiles(
  repo: string,
  base: string,
  head: string
): Promise<{ files: string[]; diagnostics: AnalysisDiagnostic[] }> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repo, 'diff', '--name-status', '-z', `${base}..${head}`],
    { encoding: 'buffer', maxBuffer: GIT_SHOW_MAX_BUFFER, timeout: GIT_COMMAND_TIMEOUT_MS }
  );
  const files = parseGitNameStatus(stdout.toString('utf8')).sort();
  const diagnostics: AnalysisDiagnostic[] = [];

  if (files.length > MAX_GIT_CHANGED_FILES) {
    diagnostics.push({
      kind: 'skipped_file_count_limit',
      message: `Stopped git changed-file discovery after ${MAX_GIT_CHANGED_FILES} files.`
    });
  }

  return { files: files.slice(0, MAX_GIT_CHANGED_FILES), diagnostics };
}

function parseGitNameStatus(output: string): string[] {
  const fields = output.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      continue;
    }

    if (status.startsWith('R') || status.startsWith('C')) {
      index += 1;
      const newPath = fields[index++];
      if (newPath) {
        files.push(newPath.replace(/\\/g, '/'));
      }
      continue;
    }

    const path = fields[index++];
    if (path && !status.startsWith('D')) {
      files.push(path.replace(/\\/g, '/'));
    }
  }

  return files;
}

async function runGitNoIndexDiff(oldPath: string, newPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '-U0', oldPath, newPath], {
      encoding: 'utf8',
      maxBuffer: GIT_SHOW_MAX_BUFFER,
      timeout: GIT_COMMAND_TIMEOUT_MS
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
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], {
      timeout: GIT_COMMAND_TIMEOUT_MS
    });
    return true;
  } catch (error) {
    if (isExecError(error)) {
      return false;
    }

    throw error;
  }
}

function surfacesForFiles(files: string[], fileContents: Record<string, string> = {}): FindingSurface[] {
  const surfaces = new Set<FindingSurface>();
  for (const file of files) {
    const surface = surfaceForPath(file) ?? (hasShellShebang(fileContents[file]) ? 'source' : undefined);
    if (surface) {
      surfaces.add(surface);
    }
  }

  return SURFACE_ORDER.filter((surface) => surfaces.has(surface));
}

function isScannableOrPotentialShebangScript(file: string): boolean {
  return isScannable(file) || isPotentialShebangScript(file);
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
  const result = await readFileAtGitRefResult(repo, ref, relativePath);
  return result.content;
}

async function readFileAtGitRefResult(
  repo: string,
  ref: string,
  relativePath: string
): Promise<{ content: string | null; diagnostic?: AnalysisDiagnostic }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'show', `${ref}:${relativePath}`], {
      encoding: 'utf8',
      maxBuffer: GIT_SHOW_MAX_BUFFER,
      timeout: GIT_COMMAND_TIMEOUT_MS
    });
    return { content: stdout };
  } catch (error) {
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

async function readChangedFilesAtRef(
  repo: string,
  ref: string,
  files: string[]
): Promise<{ contents: Record<string, string>; diagnostics: AnalysisDiagnostic[] }> {
  const entries = await mapWithConcurrency(files, GIT_SHOW_CONCURRENCY, async (file) => {
    const result = await readFileAtGitRefResult(repo, ref, file);
    return result.content === null
      ? ({ diagnostic: result.diagnostic } as const)
      : ({ entry: [file, result.content] as const } as const);
  });
  const diagnostics = entries
    .map((entry) => entry.diagnostic)
    .filter((diagnostic): diagnostic is AnalysisDiagnostic => diagnostic !== undefined);
  const contents = Object.fromEntries(
    entries
      .map((entry) => entry.entry)
      .filter((entry): entry is readonly [string, string] => entry !== undefined)
  );

  return { contents, diagnostics };
}

export function relativeFromRoots(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replace(/\\/g, '/');
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
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
