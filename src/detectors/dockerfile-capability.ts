import type { AddedLine, Finding } from '../types.js';
import { isCommentLine, isDockerfile } from '../paths.js';

export function detectDockerfileCapability(lines: AddedLine[]): Finding[] {
  const findings: Finding[] = [];

  for (const added of lines) {
    if (!isDockerfile(added.file) || isCommentLine(added.content)) {
      continue;
    }

    findings.push(...detectRemoteAdd(added));
    findings.push(...detectPipeToShell(added));
  }

  return findings;
}

function detectRemoteAdd(added: AddedLine): Finding[] {
  if (!/^\s*ADD\s+https?:\/\//i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.dockerfile_remote_add',
      surface: 'container',
      severity: 'high',
      file: added.file,
      line: added.line,
      subject: 'Dockerfile remote ADD',
      message: 'Dockerfile adds remote content during image build, expanding build-time network reach.',
      recommendation: 'Download pinned artifacts with checksum verification, or vendor reviewed files into the repository.'
    }
  ];
}

function detectPipeToShell(added: AddedLine): Finding[] {
  if (!/^\s*RUN\b.*(?:curl|wget)[^\n|]*https?:\/\/[^\n|]*\|\s*(?:ba)?sh\b/i.test(added.content)) {
    return [];
  }

  return [
    {
      kind: 'capability_echo.dockerfile_pipe_to_shell',
      surface: 'container',
      severity: 'critical',
      file: added.file,
      line: added.line,
      subject: 'Dockerfile pipe-to-shell',
      message: 'Dockerfile downloads remote content and pipes it directly to a shell during image build.',
      recommendation: 'Replace remote pipe-to-shell with pinned, reviewable build steps and checksum verification.'
    }
  ];
}
