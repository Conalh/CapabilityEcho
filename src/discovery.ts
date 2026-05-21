import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function lineOfJsonKey(text: string, key: string): number | undefined {
  const keyPattern = new RegExp(`"${escapeRegExp(key)}"\\s*:`);
  return lineOfPattern(text, keyPattern);
}

export function lineOfJsonStringValue(text: string, value: string): number | undefined {
  const encoded = JSON.stringify(value);
  return lineOfPattern(text, new RegExp(escapeRegExp(encoded)));
}

function lineOfPattern(text: string, pattern: RegExp): number | undefined {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? undefined : index + 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
