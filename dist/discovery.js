import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lineOfJsonKey as coreLineOfJsonKey, lineOfJsonStringValue as coreLineOfJsonStringValue, } from 'agent-gov-core';
export async function readJsonObject(path) {
    return (await readJsonObjectWithSource(path)).json;
}
export async function readJsonObjectWithSource(path) {
    try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw);
        return { json: isRecord(parsed) ? parsed : {}, text: raw };
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return { json: {}, text: '' };
        }
        throw error;
    }
}
export function configPath(root, relativePath) {
    return join(root, relativePath);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function lineOfJsonKey(text, key) {
    const line = coreLineOfJsonKey(text, key);
    return line === 0 ? undefined : line;
}
export function lineOfJsonStringValue(text, value) {
    const line = coreLineOfJsonStringValue(text, value);
    return line === 0 ? undefined : line;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
