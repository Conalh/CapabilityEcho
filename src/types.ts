export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  kind: string;
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
}
