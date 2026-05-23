import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
export { isMap, isScalar, isSeq };
export function parseWorkflow(text) {
    try {
        const lc = new LineCounter();
        const doc = parseDocument(text, { lineCounter: lc });
        // Real-world workflow files occasionally parse with minor errors but still
        // give us a usable AST. Accept any doc with a non-null root so the
        // structural detector can extract whatever it can — the per-line detector
        // still backs us up for the bits we can't read structurally.
        if (!doc.contents) {
            return null;
        }
        return { doc, lc };
    }
    catch {
        return null;
    }
}
export function lineOfNode(node, lc) {
    const range = rangeOfNode(node);
    if (!range) {
        return undefined;
    }
    return lc.linePos(range[0]).line;
}
export function spanOfNode(node, lc) {
    const range = rangeOfNode(node);
    if (!range) {
        return undefined;
    }
    const startLine = lc.linePos(range[0]).line;
    const endLine = lc.linePos(Math.max(range[0], range[2] - 1)).line;
    return { startLine, endLine };
}
// yaml's Pair has no `.range` of its own — the position info lives on its
// child key/value scalar nodes. Fall back to the key range so callers can
// pass either a node or a pair without case analysis at every site.
function rangeOfNode(node) {
    if (!node) {
        return undefined;
    }
    const direct = node.range;
    if (direct) {
        return direct;
    }
    const key = node.key;
    return key?.range ?? undefined;
}
export function spanOverlapsAddedLines(span, addedLines) {
    if (!span) {
        return false;
    }
    for (let line = span.startLine; line <= span.endLine; line += 1) {
        if (addedLines.has(line)) {
            return true;
        }
    }
    return false;
}
export function scalarValue(node) {
    if (isScalar(node) && typeof node.value === 'string') {
        return node.value;
    }
    return undefined;
}
