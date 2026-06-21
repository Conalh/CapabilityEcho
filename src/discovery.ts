import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  lineOfJsonKey as coreLineOfJsonKey,
  lineOfJsonStringValue as coreLineOfJsonStringValue,
  resolveWithinRoot,
  withinByteCap,
} from 'agent-gov-core';
import type { AnalysisDiagnostic } from './types.js';

const DEFAULT_EXCLUDED_DIRS = ['node_modules', '.git'] as const;
const DEFAULT_MAX_DISCOVERED_FILES = 10_000;
const DEFAULT_MAX_DISCOVERY_DEPTH = 64;

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  return (await readJsonObjectWithSource(path)).json;
}

export interface JsonObjectSource {
  json: Record<string, unknown>;
  text: string;
}

export async function readJsonObjectWithSource(path: string): Promise<JsonObjectSource> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return { json: isRecord(parsed) ? parsed : {}, text: raw };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { json: {}, text: '' };
    }

    throw error;
  }
}

export function configPath(root: string, relativePath: string): string {
  return join(root, relativePath);
}

export interface SafeFileDiscoveryOptions {
  includeFile: (relativePath: string) => boolean;
  excludedDirs?: readonly string[];
  maxFiles?: number;
  maxDepth?: number;
}

export interface SafeFileDiscoveryResult {
  files: string[];
  diagnostics: AnalysisDiagnostic[];
}

export interface SafeReadResult {
  text: string;
  diagnostic?: AnalysisDiagnostic;
}

export async function listSafeFiles(root: string, options: SafeFileDiscoveryOptions): Promise<SafeFileDiscoveryResult> {
  const excludedDirs = new Set(options.excludedDirs ?? DEFAULT_EXCLUDED_DIRS);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_DISCOVERED_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DISCOVERY_DEPTH;
  const files: string[] = [];
  const diagnostics: AnalysisDiagnostic[] = [];
  let fileLimitReported = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      diagnostics.push({
        kind: 'skipped_depth_limit',
        file: current || undefined,
        message: `Skipped ${current || '.'}: directory depth exceeded ${maxDepth}.`
      });
      return;
    }

    let entries;
    try {
      entries = await readdir(join(root, current), { withFileTypes: true });
    } catch (error) {
      diagnostics.push({
        kind: 'skipped_read_error',
        file: current || undefined,
        message: `Could not read directory ${current || '.'}: ${errorMessage(error)}.`
      });
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (excludedDirs.has(entry.name)) {
        continue;
      }

      const relativePath = normalizeRelativePath(current ? `${current}/${entry.name}` : entry.name);

      if (entry.isSymbolicLink()) {
        if (options.includeFile(relativePath)) {
          diagnostics.push({
            kind: 'skipped_symlink',
            file: relativePath,
            message: `Skipped ${relativePath}: symbolic links are not scanned in directory mode.`
          });
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(relativePath, depth + 1);
        continue;
      }

      if (!entry.isFile() || !options.includeFile(relativePath)) {
        continue;
      }

      if (files.length >= maxFiles) {
        if (!fileLimitReported) {
          diagnostics.push({
            kind: 'skipped_file_count_limit',
            message: `Stopped file discovery after ${maxFiles} matching files.`
          });
          fileLimitReported = true;
        }
        continue;
      }

      const absolute = resolveWithinRoot(root, relativePath);
      if (absolute === null) {
        diagnostics.push({
          kind: 'skipped_path_escape',
          file: relativePath,
          message: `Skipped ${relativePath}: resolved path escapes the scan root.`
        });
        continue;
      }

      let stats;
      try {
        stats = await lstat(absolute);
      } catch (error) {
        diagnostics.push({
          kind: 'skipped_read_error',
          file: relativePath,
          message: `Could not stat ${relativePath}: ${errorMessage(error)}.`
        });
        continue;
      }

      if (!withinByteCap(stats.size)) {
        diagnostics.push({
          kind: 'skipped_oversized',
          file: relativePath,
          message: `Skipped ${relativePath}: file exceeds the 10 MiB input cap.`
        });
        continue;
      }

      files.push(relativePath);
    }
  }

  await walk('', 0);
  files.sort();
  return { files, diagnostics };
}

export async function readTextWithinRoot(root: string, relativePath: string): Promise<SafeReadResult> {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = resolveWithinRoot(root, normalized);
  if (absolute === null) {
    return {
      text: '',
      diagnostic: {
        kind: 'skipped_path_escape',
        file: normalized,
        message: `Skipped ${normalized}: resolved path escapes the scan root.`
      }
    };
  }

  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { text: '' };
    }
    return {
      text: '',
      diagnostic: {
        kind: 'skipped_read_error',
        file: normalized,
        message: `Could not stat ${normalized}: ${errorMessage(error)}.`
      }
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      text: '',
      diagnostic: {
        kind: 'skipped_symlink',
        file: normalized,
        message: `Skipped ${normalized}: symbolic links are not scanned in directory mode.`
      }
    };
  }

  if (!stats.isFile()) {
    return {
      text: '',
      diagnostic: {
        kind: 'skipped_read_error',
        file: normalized,
        message: `Skipped ${normalized}: input is not a regular file.`
      }
    };
  }

  if (!withinByteCap(stats.size)) {
    return {
      text: '',
      diagnostic: {
        kind: 'skipped_oversized',
        file: normalized,
        message: `Skipped ${normalized}: file exceeds the 10 MiB input cap.`
      }
    };
  }

  try {
    return { text: await readFile(absolute, 'utf8') };
  } catch (error) {
    return {
      text: '',
      diagnostic: {
        kind: 'skipped_read_error',
        file: normalized,
        message: `Could not read ${normalized}: ${errorMessage(error)}.`
      }
    };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function lineOfJsonKey(text: string, key: string): number | undefined {
  const line = coreLineOfJsonKey(text, key);
  return line === 0 ? undefined : line;
}

export function lineOfJsonStringValue(text: string, value: string): number | undefined {
  const line = coreLineOfJsonStringValue(text, value);
  return line === 0 ? undefined : line;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
