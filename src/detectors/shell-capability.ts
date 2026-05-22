import type { AddedLine, Finding } from '../types.js';
import { isCommentLine, isShellFile } from '../paths.js';

export function detectShellCapability(lines: AddedLine[]): Finding[] {
  const findings: Finding[] = [];

  for (const added of lines) {
    if (!isShellFile(added.file) || isCommentLine(added.content)) {
      continue;
    }

    findings.push(...detectPipeToShell(added));
    findings.push(...detectExternalDownload(added));
  }

  return findings;
}

function detectPipeToShell(added: AddedLine): Finding[] {
  if (!/(?:curl|wget|Invoke-WebRequest|iwr)[^\n|]*https?:\/\/[^\n|]*\|\s*(?:ba)?sh\b|iex\s*\(|Invoke-Expression/i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'shell_pipe_to_shell',
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

function detectExternalDownload(added: AddedLine): Finding[] {
  if (!/\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*https?:\/\//i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'shell_external_download',
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
