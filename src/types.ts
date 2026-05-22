export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type FindingSurface = 'source' | 'package' | 'workflow' | 'container';

export interface Finding {
  kind: string;
  surface: FindingSurface;
  severity: Severity;
  file: string;
  line?: number;
  subject: string;
  message: string;
  recommendation: string;
}

export interface AddedLine {
  file: string;
  line: number;
  content: string;
}

export interface DiffContext {
  addedLines: AddedLine[];
  changedFileCount: number;
  scannedSurfaces: FindingSurface[];
  newFileContents: Record<string, string>;
}
