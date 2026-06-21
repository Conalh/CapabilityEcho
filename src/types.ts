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
  exceptionStatus?: 'expired';
  exceptionReason?: string;
}

export interface AddedLine {
  file: string;
  line: number;
  content: string;
}

export type AnalysisDiagnosticKind =
  | 'skipped_symlink'
  | 'skipped_oversized'
  | 'skipped_path_escape'
  | 'skipped_file_count_limit'
  | 'skipped_depth_limit'
  | 'skipped_read_error'
  | 'git_read_failed'
  | 'git_diff_failed'
  | 'exception_config_error';

export interface AnalysisDiagnostic {
  kind: AnalysisDiagnosticKind;
  file?: string;
  message: string;
}

export interface DiffContext {
  addedLines: AddedLine[];
  changedFileCount: number;
  scannedSurfaces: FindingSurface[];
  newFileContents: Record<string, string>;
  analysisIncomplete: boolean;
  analysisDiagnostics: AnalysisDiagnostic[];
}
