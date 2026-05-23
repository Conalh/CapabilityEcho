import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document, Node, Pair, Scalar } from 'yaml';

export { isMap, isScalar, isSeq };

export interface ParsedWorkflow {
  doc: Document.Parsed;
  lc: LineCounter;
}

export function parseWorkflow(text: string): ParsedWorkflow | null {
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
  } catch {
    return null;
  }
}

export function lineOfNode(node: Node | Pair | undefined | null, lc: LineCounter): number | undefined {
  const range = rangeOfNode(node);
  if (!range) {
    return undefined;
  }
  return lc.linePos(range[0]).line;
}

export function spanOfNode(
  node: Node | Pair | undefined | null,
  lc: LineCounter
): { startLine: number; endLine: number } | undefined {
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
function rangeOfNode(
  node: Node | Pair | undefined | null
): [number, number, number] | undefined {
  if (!node) {
    return undefined;
  }
  const direct = (node as { range?: [number, number, number] | null }).range;
  if (direct) {
    return direct;
  }
  const key = (node as { key?: { range?: [number, number, number] | null } }).key;
  return key?.range ?? undefined;
}

export function spanOverlapsAddedLines(
  span: { startLine: number; endLine: number } | undefined,
  addedLines: Set<number>
): boolean {
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

export function scalarValue(node: unknown): string | undefined {
  if (isScalar(node) && typeof (node as Scalar).value === 'string') {
    return (node as Scalar).value as string;
  }
  return undefined;
}
