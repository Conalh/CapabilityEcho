import type { DiffContext, Finding, Severity } from './types.js';

export type EchoRating = 'none' | Severity;
export type ReportFormat = 'text' | 'markdown' | 'json' | 'github';

export interface EchoReport {
  rating: EchoRating;
  findingCount: number;
  changedFileCount: number;
  capabilitySummary: string[];
  findings: Finding[];
}

const severityRank: Record<EchoRating, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const SUMMARY_LABELS: Record<string, string> = {
  external_fetch_added: 'external network fetch calls',
  subprocess_spawn_added: 'subprocess or shell spawn calls',
  dynamic_eval_added: 'dynamic code execution',
  workflow_permission_write: 'GitHub Actions write permissions',
  workflow_external_curl: 'workflow external network requests',
  workflow_secret_exfil_pattern: 'workflow secret exfiltration patterns',
  lifecycle_script_added: 'npm lifecycle scripts',
  script_pipe_to_shell: 'pipe-to-shell install scripts',
  script_network_command: 'network or publish npm scripts'
};

export function createReport(findings: Finding[], context: DiffContext): EchoReport {
  return {
    rating: rateFindings(findings),
    findingCount: findings.length,
    changedFileCount: context.changedFileCount,
    capabilitySummary: buildCapabilitySummary(findings),
    findings
  };
}

export function renderReport(report: EchoReport, format: ReportFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  if (format === 'markdown') {
    return renderMarkdown(report);
  }

  if (format === 'github') {
    return renderGithubAnnotations(report);
  }

  return renderText(report);
}

function buildCapabilitySummary(findings: Finding[]): string[] {
  const labels = new Set<string>();
  for (const finding of findings) {
    labels.add(SUMMARY_LABELS[finding.kind] ?? finding.kind);
  }
  return [...labels];
}

function rateFindings(findings: Finding[]): EchoRating {
  let rating: EchoRating = 'none';
  for (const finding of findings) {
    if (severityRank[finding.severity] > severityRank[rating]) {
      rating = finding.severity;
    }
  }

  return rating;
}

function renderMarkdown(report: EchoReport): string {
  const lines = [`# CapabilityEcho capability drift: ${report.rating.toUpperCase()}`, ''];

  if (report.findings.length === 0) {
    lines.push('No code or workflow capability drift findings.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`This diff scanned ${report.changedFileCount} changed file${report.changedFileCount === 1 ? '' : 's'}.`);
  lines.push(`CapabilityEcho found ${report.findingCount} finding${report.findingCount === 1 ? '' : 's'}.`, '');

  if (report.capabilitySummary.length > 0) {
    lines.push('## Capability summary', '');
    for (const item of report.capabilitySummary) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    const matches = report.findings.filter((finding) => finding.severity === severity);
    if (matches.length === 0) {
      continue;
    }

    lines.push(`## ${capitalize(severity)}`, '');
    for (const finding of matches) {
      lines.push(`- **${finding.subject}** (${finding.file}): ${finding.message}`);
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderText(report: EchoReport): string {
  const lines = [`CapabilityEcho capability drift: ${report.rating.toUpperCase()}`];
  if (report.capabilitySummary.length > 0) {
    lines.push(`Signals: ${report.capabilitySummary.join(', ')}`);
  }

  for (const finding of report.findings) {
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.subject}: ${finding.message}`);
  }

  if (report.findings.length === 0) {
    lines.push('No code or workflow capability drift findings.');
  }

  return `${lines.join('\n')}\n`;
}

function renderGithubAnnotations(report: EchoReport): string {
  if (report.findings.length === 0) {
    return '';
  }

  return (
    report.findings
      .map((finding) => {
        const title = `CapabilityEcho ${finding.severity} capability drift`;
        const message = `${finding.message} Recommendation: ${finding.recommendation}`;
        const properties = [`file=${escapeProperty(finding.file)}`];
        if (finding.line && finding.line > 0) {
          properties.push(`line=${finding.line}`);
        }
        properties.push(`title=${escapeProperty(title)}`);
        return `::warning ${properties.join(',')}::${escapeMessage(message)}`;
      })
      .join('\n') + '\n'
  );
}

function escapeMessage(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeProperty(value: string): string {
  return escapeMessage(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
