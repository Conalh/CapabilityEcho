import { listSafeFiles, readTextWithinRoot } from './discovery.js';
import { listGitChangedFiles, readFileAtGitRef } from './git-diff.js';
import { isNpmLockfile, isPackageJsonFile, isPythonManifestFile } from './paths.js';
import type { TextDiffInput } from './types.js';

export type TextDiffMode =
  | { mode: 'directories'; oldRoot: string; newRoot: string }
  | { mode: 'git'; repo: string; base: string; head: string };

type IncludeFile = (relativePath: string) => boolean;

export async function collectPackageJsonDiffs(mode: TextDiffMode): Promise<TextDiffInput[]> {
  return collectTextDiffs(mode, isPackageJsonFile);
}

export async function collectNpmLockfileDiffs(mode: TextDiffMode): Promise<TextDiffInput[]> {
  return collectTextDiffs(mode, isNpmLockfile);
}

export async function collectPythonManifestDiffs(mode: TextDiffMode): Promise<TextDiffInput[]> {
  return collectTextDiffs(mode, isPythonManifestFile, ['node_modules', '.git', '.venv', 'venv']);
}

async function collectTextDiffs(
  mode: TextDiffMode,
  includeFile: IncludeFile,
  excludedDirs?: readonly string[]
): Promise<TextDiffInput[]> {
  const files =
    mode.mode === 'directories'
      ? (await listSafeFiles(mode.newRoot, { includeFile, ...(excludedDirs ? { excludedDirs } : {}) })).files
      : (await listGitChangedFiles(mode.repo, mode.base, mode.head)).filter(includeFile);

  return Promise.all(
    files.map(async (file) => ({
      file,
      oldText: await readTextAt(mode, file, 'old'),
      newText: await readTextAt(mode, file, 'new')
    }))
  );
}

async function readTextAt(mode: TextDiffMode, file: string, side: 'old' | 'new'): Promise<string> {
  if (mode.mode === 'directories') {
    const root = side === 'old' ? mode.oldRoot : mode.newRoot;
    return (await readTextWithinRoot(root, file)).text;
  }

  const ref = side === 'old' ? mode.base : mode.head;
  return (await readFileAtGitRef(mode.repo, ref, file)) ?? '';
}
