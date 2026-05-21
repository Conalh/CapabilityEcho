import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    const keyPattern = new RegExp(`"${escapeRegExp(key)}"\\s*:`);
    return lineOfPattern(text, keyPattern);
}
export function lineOfJsonStringValue(text, value) {
    const encoded = JSON.stringify(value);
    return lineOfPattern(text, new RegExp(escapeRegExp(encoded)));
}
function lineOfPattern(text, pattern) {
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex((line) => pattern.test(line));
    return index === -1 ? undefined : index + 1;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
