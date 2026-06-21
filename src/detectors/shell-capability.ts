import type { AddedLine, Finding } from '../types.js';
import { hasShellShebang, isCommentLine, isShellFile } from '../paths.js';

export function detectShellCapability(lines: AddedLine[], newFileContents: Record<string, string> = {}): Finding[] {
  const findings: Finding[] = [];

  for (const added of lines) {
    if (!isShellScannableFile(added.file, newFileContents) || isCommentLine(added.content)) {
      continue;
    }

    findings.push(...detectPipeToShell(added));
    findings.push(...detectExternalDownload(added));
  }

  return findings;
}

function isShellScannableFile(file: string, newFileContents: Record<string, string>): boolean {
  return isShellFile(file) || hasShellShebang(newFileContents[file]);
}

function detectPipeToShell(added: AddedLine): Finding[] {
  if (!hasRemotePipeToShell(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.shell_pipe_to_shell',
      surface: 'source',
      severity: 'critical',
      file: added.file,
      line: added.line,
      subject: 'Shell remote pipe-to-shell',
      message: 'Added shell script downloads remote content and pipes it directly to a shell.',
      recommendation: 'Replace remote pipe-to-shell with pinned, reviewable install steps.'
    }
  ];
}

function hasRemotePipeToShell(content: string): boolean {
  return (
    /\b(?:curl|wget)\b[^\n|]*https?:\/\/[^\n|]*\|\s*(?:ba)?sh\b/i.test(content) ||
    /\b(?:Invoke-WebRequest|iwr|curl|wget)\b[^\n|]*https?:\/\/[^\n|]*\|\s*(?:iex|Invoke-Expression)\b/i.test(content) ||
    /\b(?:iex|Invoke-Expression)\s*(?:\(|\s+)\s*(?:Invoke-WebRequest|iwr|curl|wget)\b[^)]*https?:\/\//i.test(content)
  );
}

function detectExternalDownload(added: AddedLine): Finding[] {
  if (!/\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*https?:\/\//i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.shell_external_download',
      surface: 'source',
      severity: 'medium',
      file: added.file,
      line: added.line,
      subject: 'Shell external download',
      message: 'Added shell script downloads content from an external URL.',
      recommendation: 'Verify the URL, checksum or signature, and whether the download belongs in this change.'
    }
  ];
}
