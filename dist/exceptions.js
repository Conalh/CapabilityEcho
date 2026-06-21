import { validateException } from 'agent-gov-core';
import { readTextWithinRoot } from './discovery.js';
import { readFileAtGitRef } from './git-diff.js';
import { toCanonicalFinding } from './report.js';
export const DEFAULT_EXCEPTIONS_FILE = '.capabilityecho-exceptions.json';
export async function applyExceptionBaseline(findings, mode) {
    const loaded = await loadExceptions(mode);
    const policyFindings = buildPolicyFindings(loaded);
    if (loaded.exceptions.length === 0) {
        return {
            findings: [...findings, ...policyFindings],
            suppressedFindingCount: 0,
            expiredExceptionCount: 0,
            suppressedFindings: [],
            diagnostics: loaded.diagnostics
        };
    }
    const applied = applyTrustedExceptions(findings, loaded.exceptions);
    return {
        findings: [...applied.findings, ...policyFindings],
        suppressedFindingCount: applied.suppressedFindingCount,
        expiredExceptionCount: applied.expiredExceptionCount,
        suppressedFindings: applied.suppressedFindings,
        diagnostics: loaded.diagnostics
    };
}
async function loadExceptions(mode) {
    const exceptionsFile = normalizeExceptionPath(mode.exceptionsFile || DEFAULT_EXCEPTIONS_FILE);
    if (!exceptionsFile) {
        return {
            exceptions: [],
            exceptionsFile,
            policyChanged: false,
            diagnostics: [
                {
                    kind: 'exception_config_error',
                    message: `Invalid exceptions file path: ${mode.exceptionsFile || DEFAULT_EXCEPTIONS_FILE}.`
                }
            ]
        };
    }
    const explicit = Boolean(mode.exceptionsFile);
    const trusted = mode.mode === 'directories'
        ? await readDirectoryExceptionFile(mode.trustedRoot, exceptionsFile, explicit)
        : await readGitExceptionFile(mode.repo, mode.trustedRef, exceptionsFile, explicit);
    const candidate = mode.mode === 'directories'
        ? await readDirectoryExceptionFile(mode.candidateRoot, exceptionsFile, false)
        : await readGitExceptionFile(mode.repo, mode.candidateRef, exceptionsFile, false);
    const diagnostics = [...trusted.diagnostics];
    const policyChanged = trusted.content !== candidate.content;
    if (policyChanged && candidate.content.trim()) {
        const candidateParsed = parseExceptionConfig(candidate.content, exceptionsFile);
        diagnostics.push(...candidateParsed.diagnostics);
    }
    if (trusted.diagnostics.length > 0 || !trusted.content.trim()) {
        return { exceptions: [], diagnostics, exceptionsFile, policyChanged };
    }
    const trustedParsed = parseExceptionConfig(trusted.content, exceptionsFile);
    return {
        ...trustedParsed,
        diagnostics: [...diagnostics, ...trustedParsed.diagnostics],
        exceptionsFile,
        policyChanged
    };
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
function applyTrustedExceptions(findings, exceptions, now = new Date()) {
    const out = [];
    const suppressedFindings = [];
    let expiredExceptionCount = 0;
    for (const finding of findings) {
        const canonical = toCanonicalFinding(finding);
        const matches = findAllMatchingExceptions(canonical, exceptions);
        if (matches.length === 0) {
            out.push(finding);
            continue;
        }
        const active = matches.find((exception) => !exception.expires || !isExpired(exception.expires, now));
        if (active) {
            suppressedFindings.push(toSuppressedMetadata(canonical, active));
            continue;
        }
        out.push(finding);
        out.push(toExpiredExceptionFinding(finding, matches[0]));
        expiredExceptionCount += 1;
    }
    return {
        findings: out,
        suppressedFindingCount: suppressedFindings.length,
        expiredExceptionCount,
        suppressedFindings
    };
}
function findAllMatchingExceptions(finding, exceptions) {
    const out = [];
    for (const exception of exceptions) {
        if (exception.kind !== finding.kind) {
            continue;
        }
        if (exception.salientKey !== undefined && exception.salientKey !== finding.salientKey) {
            continue;
        }
        if (exception.pathPrefix !== undefined && !pathPrefixMatches(finding.location?.file, exception.pathPrefix)) {
            continue;
        }
        out.push(exception);
    }
    return out;
}
function toSuppressedMetadata(finding, exception) {
    return {
        fingerprint: finding.fingerprint ?? '',
        kind: finding.kind,
        location: {
            file: finding.location?.file ?? '',
            ...(finding.location?.line !== undefined ? { line: finding.location.line } : {})
        },
        reason: exception.reason ?? '',
        ...(exception.expires !== undefined ? { expires: exception.expires } : {})
    };
}
function toExpiredExceptionFinding(finding, exception) {
    return {
        kind: 'capability_echo.exception_expired',
        surface: finding.surface,
        severity: 'low',
        file: finding.file,
        line: finding.line,
        subject: 'Expired CapabilityEcho exception',
        message: 'A matching CapabilityEcho exception has expired; the original finding is reported at its original severity.',
        recommendation: 'Remove or renew the exception after reviewing the underlying finding.',
        exceptionStatus: 'expired',
        exceptionReason: exception.reason
    };
}
function buildPolicyFindings(loaded) {
    if (!loaded.policyChanged || !loaded.exceptionsFile) {
        return [];
    }
    return [
        {
            kind: 'capability_echo.exception_policy_changed',
            surface: 'workflow',
            severity: 'high',
            file: loaded.exceptionsFile,
            subject: 'CapabilityEcho exception policy changed',
            message: 'This diff changes the CapabilityEcho exception policy; current analysis used the trusted base policy, and candidate policy changes take effect only after merge.',
            recommendation: 'Review exception additions, removals, and widening separately from the suppressed findings they may affect.'
        }
    ];
}
function pathPrefixMatches(file, prefix) {
    if (!file) {
        return false;
    }
    const fileNorm = file.replace(/\\/g, '/');
    const prefixNorm = prefix.replace(/\\/g, '/');
    if (!fileNorm.startsWith(prefixNorm)) {
        return false;
    }
    if (fileNorm.length === prefixNorm.length || prefixNorm.endsWith('/')) {
        return true;
    }
    return fileNorm[prefixNorm.length] === '/';
}
function isExpired(expires, now) {
    const parsed = new Date(expires);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }
    return parsed.getTime() < now.getTime();
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
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
