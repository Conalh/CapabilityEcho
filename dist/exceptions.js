import { applyExceptions, validateException } from 'agent-gov-core';
import { readTextWithinRoot } from './discovery.js';
import { readFileAtGitRef } from './git-diff.js';
import { toCanonicalFinding } from './report.js';
export const DEFAULT_EXCEPTIONS_FILE = '.capabilityecho-exceptions.json';
export async function applyExceptionBaseline(findings, mode) {
    const loaded = await loadExceptions(mode);
    if (loaded.exceptions.length === 0) {
        return {
            findings,
            suppressedFindingCount: 0,
            expiredExceptionCount: 0,
            diagnostics: loaded.diagnostics
        };
    }
    const originalsByFingerprint = new Map();
    const canonicalFindings = findings.map((finding) => {
        const canonical = toCanonicalFinding(finding);
        if (canonical.fingerprint) {
            originalsByFingerprint.set(canonical.fingerprint, finding);
        }
        return canonical;
    });
    const applied = applyExceptions(canonicalFindings, loaded.exceptions);
    return {
        findings: applied.findings.map((finding) => fromCanonicalFinding(finding, originalsByFingerprint)),
        suppressedFindingCount: applied.suppressed,
        expiredExceptionCount: applied.expired,
        diagnostics: loaded.diagnostics
    };
}
async function loadExceptions(mode) {
    const exceptionsFile = normalizeExceptionPath(mode.exceptionsFile || DEFAULT_EXCEPTIONS_FILE);
    if (!exceptionsFile) {
        return {
            exceptions: [],
            diagnostics: [
                {
                    kind: 'exception_config_error',
                    message: `Invalid exceptions file path: ${mode.exceptionsFile || DEFAULT_EXCEPTIONS_FILE}.`
                }
            ]
        };
    }
    const explicit = Boolean(mode.exceptionsFile);
    const text = mode.mode === 'directories'
        ? await readDirectoryExceptionFile(mode.root, exceptionsFile, explicit)
        : await readGitExceptionFile(mode.repo, mode.head, exceptionsFile, explicit);
    if (text.diagnostics.length > 0 || !text.content.trim()) {
        return { exceptions: [], diagnostics: text.diagnostics };
    }
    return parseExceptionConfig(text.content, exceptionsFile);
}
async function readDirectoryExceptionFile(root, relativePath, explicit) {
    const read = await readTextWithinRoot(root, relativePath);
    if (read.diagnostic) {
        return {
            content: '',
            diagnostics: [
                {
                    kind: 'exception_config_error',
                    file: relativePath,
                    message: `Could not read exceptions file ${relativePath}: ${read.diagnostic.message}`
                }
            ]
        };
    }
    if (explicit && !read.text.trim()) {
        return {
            content: '',
            diagnostics: [
                {
                    kind: 'exception_config_error',
                    file: relativePath,
                    message: `Explicit exceptions file ${relativePath} was empty or missing.`
                }
            ]
        };
    }
    return { content: read.text, diagnostics: [] };
}
async function readGitExceptionFile(repo, head, relativePath, explicit) {
    const content = await readFileAtGitRef(repo, head, relativePath);
    if (content === null) {
        return explicit
            ? {
                content: '',
                diagnostics: [
                    {
                        kind: 'exception_config_error',
                        file: relativePath,
                        message: `Explicit exceptions file ${relativePath} could not be read at ${head}.`
                    }
                ]
            }
            : { content: '', diagnostics: [] };
    }
    return { content, diagnostics: [] };
}
function parseExceptionConfig(text, file) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return {
            exceptions: [],
            diagnostics: [
                {
                    kind: 'exception_config_error',
                    file,
                    message: `Could not parse ${file}: ${errorMessage(error)}.`
                }
            ]
        };
    }
    const entries = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.exceptions)
            ? parsed.exceptions
            : undefined;
    if (!entries) {
        return {
            exceptions: [],
            diagnostics: [
                {
                    kind: 'exception_config_error',
                    file,
                    message: `${file} must be a JSON array or an object with an exceptions array.`
                }
            ]
        };
    }
    const exceptions = [];
    const diagnostics = [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const validation = validateException(entry);
        const errors = [...validation.errors];
        if (!isRecord(entry) || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
            errors.push('reason must be a non-empty string');
        }
        if (errors.length > 0) {
            diagnostics.push({
                kind: 'exception_config_error',
                file,
                message: `${file} exceptions[${index}] is invalid: ${errors.join('; ')}.`
            });
            continue;
        }
        exceptions.push(entry);
    }
    return diagnostics.length > 0 ? { exceptions: [], diagnostics } : { exceptions, diagnostics: [] };
}
function fromCanonicalFinding(finding, originalsByFingerprint) {
    const original = finding.fingerprint ? originalsByFingerprint.get(finding.fingerprint) : undefined;
    if (original) {
        const exceptionReason = typeof finding.data?.exceptionReason === 'string' ? finding.data.exceptionReason : original.exceptionReason;
        return {
            ...original,
            severity: finding.severity,
            message: finding.message,
            exceptionStatus: exceptionReason ? 'expired' : original.exceptionStatus,
            exceptionReason
        };
    }
    const surface = isFindingSurface(finding.data?.surface) ? finding.data.surface : 'source';
    return {
        kind: finding.kind,
        surface,
        severity: finding.severity,
        file: finding.location?.file ?? '',
        line: finding.location?.line,
        subject: typeof finding.data?.subject === 'string' ? finding.data.subject : finding.salientKey ?? finding.kind,
        message: finding.message,
        recommendation: typeof finding.data?.recommendation === 'string' ? finding.data.recommendation : 'Review the finding.',
        exceptionStatus: finding.data?.exceptionReason ? 'expired' : undefined,
        exceptionReason: typeof finding.data?.exceptionReason === 'string' ? finding.data.exceptionReason : undefined
    };
}
function normalizeExceptionPath(value) {
    const normalized = value.replace(/\\/g, '/').trim();
    if (!normalized ||
        normalized.startsWith('/') ||
        /^[a-z]:\//i.test(normalized) ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.includes('/../') ||
        normalized.includes('\0')) {
        return undefined;
    }
    return normalized;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFindingSurface(value) {
    return value === 'source' || value === 'package' || value === 'workflow' || value === 'container';
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
