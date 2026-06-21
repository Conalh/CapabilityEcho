import {
  createFinding as createCanonicalFinding,
  createReport as createCanonicalReport,
  type Finding as CanonicalFinding,
  type Report as CanonicalReport,
} from 'agent-gov-core';
import type { AnalysisDiagnostic, DiffContext, Finding, FindingSurface, Severity, SuppressedFindingMetadata } from './types.js';

export type EchoRating = 'none' | Severity;
export type ReportFormat = 'text' | 'markdown' | 'json' | 'github';

export interface EchoReport {
  rating: EchoRating;
  findingCount: number;
  changedFileCount: number;
  scannedSurfaces: FindingSurface[];
  excludedSurfaces: string[];
  analysisIncomplete: boolean;
  analysisDiagnosticCount: number;
  analysisDiagnostics: AnalysisDiagnostic[];
  suppressedFindingCount: number;
  expiredExceptionCount: number;
  suppressedFindings: SuppressedFindingMetadata[];
  surfaceSummary: Record<FindingSurface, number>;
  severitySummary: Record<Severity, number>;
  capabilitySummary: string[];
  topRecommendations: string[];
  findings: Finding[];
}

const EXCLUDED_SURFACES = ['AI-agent config'] as const;
const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

const SURFACE_LABELS: Record<FindingSurface, string> = {
  source: 'source code',
  package: 'package manifests',
  workflow: 'GitHub workflows',
  container: 'container builds'
};

export const severityRank: Record<EchoRating, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const SUMMARY_LABELS: Record<string, string> = {
  'capability_echo.external_fetch_added': 'external network fetch calls',
  'capability_echo.source_secret_exfil_pattern': 'source secret exfiltration patterns',
  'capability_echo.subprocess_spawn_added': 'subprocess or shell spawn calls',
  'capability_echo.dynamic_eval_added': 'dynamic code execution',
  'capability_echo.shell_pipe_to_shell': 'shell pipe-to-shell downloads',
  'capability_echo.shell_external_download': 'shell external downloads',
  'capability_echo.dockerfile_remote_add': 'Dockerfile remote ADD instructions',
  'capability_echo.dockerfile_pipe_to_shell': 'Dockerfile pipe-to-shell builds',
  'capability_echo.workflow_permission_write': 'GitHub Actions write permissions',
  'capability_echo.workflow_workflow_level_write_permission': 'GitHub Actions workflow-level write permissions',
  'capability_echo.workflow_pull_request_target': 'GitHub Actions pull_request_target triggers',
  'capability_echo.workflow_pr_head_checkout_on_target': 'GitHub Actions PR-head reference under pull_request_target',
  'capability_echo.workflow_self_hosted_runner': 'GitHub Actions self-hosted runners',
  'capability_echo.workflow_mutable_action_ref': 'GitHub Actions mutable action references',
  'capability_echo.workflow_secrets_inherit': 'GitHub Actions inherited secrets',
  'capability_echo.workflow_external_curl': 'workflow external network requests',
  'capability_echo.workflow_secret_exfil_pattern': 'workflow secret exfiltration patterns',
  'capability_echo.workflow_docker_socket_mount': 'workflow Docker socket mounts',
  'capability_echo.workflow_privileged_container': 'workflow privileged containers',
  'capability_echo.lifecycle_script_added': 'npm lifecycle scripts',
  'capability_echo.script_pipe_to_shell': 'pipe-to-shell install scripts',
  'capability_echo.script_network_command': 'network or publish npm scripts',
  'capability_echo.high_capability_dep_added': 'high-capability dependency additions',
  'capability_echo.telemetry_dep_added': 'telemetry dependency additions',
  'capability_echo.unsafe_deserialize_added': 'unsafe deserialization',
  'capability_echo.lockfile_high_capability_dep_added': 'lockfile transitive high-capability deps',
  'capability_echo.lockfile_telemetry_dep_added': 'lockfile transitive telemetry deps',
  'capability_echo.lockfile_install_script_added': 'lockfile transitive install scripts',
  'capability_echo.exception_expired': 'expired CapabilityEcho exceptions',
  'capability_echo.exception_policy_changed': 'CapabilityEcho exception policy changes'
};

export interface ExceptionReportSummary {
  suppressedFindingCount: number;
  expiredExceptionCount: number;
  suppressedFindings: SuppressedFindingMetadata[];
}

export function createReport(
  findings: Finding[],
  context: DiffContext,
  exceptionSummary: ExceptionReportSummary = { suppressedFindingCount: 0, expiredExceptionCount: 0, suppressedFindings: [] }
): EchoReport {
  return {
    rating: rateFindings(findings),
    findingCount: findings.length,
    changedFileCount: context.changedFileCount,
    scannedSurfaces: context.scannedSurfaces,
    excludedSurfaces: [...EXCLUDED_SURFACES],
    analysisIncomplete: context.analysisIncomplete,
    analysisDiagnosticCount: context.analysisDiagnostics.length,
    analysisDiagnostics: context.analysisDiagnostics,
    suppressedFindingCount: exceptionSummary.suppressedFindingCount,
    expiredExceptionCount: exceptionSummary.expiredExceptionCount,
    suppressedFindings: exceptionSummary.suppressedFindings,
    surfaceSummary: buildSurfaceSummary(findings),
    severitySummary: buildSeveritySummary(findings),
    capabilitySummary: buildCapabilitySummary(findings),
    topRecommendations: buildTopRecommendations(findings),
    findings
  };
}

/**
 * Project a CapabilityEcho-internal {@link EchoReport} into the canonical
 * agent-gov-core {@link CanonicalReport} envelope. Used at the JSON
 * serialization boundary so cross-tool meta-reviewers (GovVerdict) ingest
 * one shape across the whole suite. CapabilityEcho-specific top-level
 * fields move under `Report.data`; per-finding extras (`subject`,
 * `recommendation`, `surface`) ride under each canonical Finding's
 * `data.*`. Internal markdown / text / github renderers continue to
 * consume `EchoReport` directly.
 */
export function toCanonicalReport(report: EchoReport): CanonicalReport {
  const findings: CanonicalFinding[] = report.findings.map(toCanonicalFinding);
  return createCanonicalReport({
    tool: 'capability_echo',
    findings,
    data: {
      changedFileCount: report.changedFileCount,
      scannedSurfaces: report.scannedSurfaces,
      excludedSurfaces: report.excludedSurfaces,
      analysisIncomplete: report.analysisIncomplete,
      analysisDiagnosticCount: report.analysisDiagnosticCount,
      analysisDiagnostics: report.analysisDiagnostics,
      suppressedFindingCount: report.suppressedFindingCount,
      expiredExceptionCount: report.expiredExceptionCount,
      suppressedFindings: report.suppressedFindings,
      surfaceSummary: report.surfaceSummary,
      severitySummary: report.severitySummary,
      capabilitySummary: report.capabilitySummary,
      topRecommendations: report.topRecommendations,
    },
  });
}

export function toCanonicalFinding(f: Finding): CanonicalFinding {
  const name = f.kind.startsWith('capability_echo.')
    ? f.kind.slice('capability_echo.'.length)
    : f.kind;
  const data: Record<string, unknown> = {
    subject: f.subject,
    recommendation: f.recommendation,
    surface: f.surface
  };
  if (f.exceptionStatus) {
    data.exceptionStatus = f.exceptionStatus;
  }
  if (f.exceptionReason) {
    data.exceptionReason = f.exceptionReason;
  }

  return createCanonicalFinding({
    tool: 'capability_echo',
    name,
    severity: f.severity,
    message: f.message,
    location: f.line !== undefined ? { file: f.file, line: f.line } : { file: f.file },
    data,
    salientKey: f.subject,
  });
}

export function renderReport(report: EchoReport, format: ReportFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(toCanonicalReport(report), null, 2)}\n`;
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

function buildTopRecommendations(findings: Finding[]): string[] {
  const recommendations = new Set<string>();
  const rankedFindings = findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => {
      const severityDelta = severityRank[right.finding.severity] - severityRank[left.finding.severity];
      return severityDelta === 0 ? left.index - right.index : severityDelta;
    });

  for (const { finding } of rankedFindings) {
    recommendations.add(finding.recommendation);
    if (recommendations.size === 3) {
      break;
    }
  }

  return [...recommendations];
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

  lines.push(`Scanned executable surfaces: ${formatSurfaces(report.scannedSurfaces)}.`);
  lines.push(`Excluded surfaces: ${report.excludedSurfaces.join(', ')}.`, '');

  if (report.analysisIncomplete) {
    lines.push(`> Analysis incomplete: ${report.analysisDiagnosticCount} input${report.analysisDiagnosticCount === 1 ? '' : 's'} could not be examined.`, '');
  }

  if (report.suppressedFindingCount > 0 || report.expiredExceptionCount > 0) {
    lines.push(`Suppressed by active exceptions: ${report.suppressedFindingCount}.`);
    lines.push(`Expired exceptions resurfaced: ${report.expiredExceptionCount}.`, '');
  }

  if (report.findings.length === 0) {
    lines.push('No code or workflow capability drift findings.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`This diff scanned ${report.changedFileCount} changed file${report.changedFileCount === 1 ? '' : 's'}.`);
  lines.push(`CapabilityEcho found ${report.findingCount} finding${report.findingCount === 1 ? '' : 's'}.`, '');
  if (report.topRecommendations.length > 0) {
    lines.push('## Top recommendations', '');
    for (const recommendation of report.topRecommendations) {
      lines.push(`- ${recommendation}`);
    }
    lines.push('');
  }
  lines.push('## Review summary', '');
  lines.push('| Surface | Findings |');
  lines.push('| --- | ---: |');
  for (const surface of ['source', 'package', 'workflow', 'container'] as const) {
    lines.push(`| ${SURFACE_LABELS[surface]} | ${report.surfaceSummary[surface]} |`);
  }
  lines.push('');
  lines.push('| Severity | Findings |');
  lines.push('| --- | ---: |');
  for (const severity of SEVERITY_ORDER) {
    lines.push(`| ${capitalize(severity)} | ${report.severitySummary[severity]} |`);
  }
  lines.push('');

  if (report.capabilitySummary.length > 0) {
    lines.push('## Capability summary', '');
    for (const item of report.capabilitySummary) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  for (const severity of SEVERITY_ORDER) {
    const matches = report.findings.filter((finding) => finding.severity === severity);
    if (matches.length === 0) {
      continue;
    }

    lines.push(`## ${capitalize(severity)}`, '');
    for (const finding of matches) {
      lines.push(`- **${finding.subject}** [${SURFACE_LABELS[finding.surface]}] (${finding.file}): ${finding.message}`);
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderText(report: EchoReport): string {
  const lines = [`CapabilityEcho capability drift: ${report.rating.toUpperCase()}`];
  lines.push(`Scanned executable surfaces: ${formatSurfaces(report.scannedSurfaces)}.`);
  lines.push(`Excluded surfaces: ${report.excludedSurfaces.join(', ')}.`);
  if (report.analysisIncomplete) {
    lines.push(`Analysis incomplete: ${report.analysisDiagnosticCount} input${report.analysisDiagnosticCount === 1 ? '' : 's'} could not be examined.`);
  }
  if (report.suppressedFindingCount > 0 || report.expiredExceptionCount > 0) {
    lines.push(`Suppressed by active exceptions: ${report.suppressedFindingCount}.`);
    lines.push(`Expired exceptions resurfaced: ${report.expiredExceptionCount}.`);
  }

  if (report.capabilitySummary.length > 0) {
    lines.push(`Signals: ${report.capabilitySummary.join(', ')}`);
  }
  if (report.topRecommendations.length > 0) {
    lines.push(`Top recommendations: ${report.topRecommendations.join(' | ')}`);
  }

  for (const finding of report.findings) {
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.subject} (${SURFACE_LABELS[finding.surface]}): ${finding.message}`);
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
        const level =
          finding.severity === 'critical' || finding.severity === 'high' ? 'error' : 'warning';
        const title = `CapabilityEcho ${finding.severity} ${SURFACE_LABELS[finding.surface]} capability drift`;
        const message = `${finding.message} Recommendation: ${finding.recommendation}`;
        const properties = [`file=${escapeProperty(finding.file)}`];
        if (finding.line && finding.line > 0) {
          properties.push(`line=${finding.line}`);
        }
        properties.push(`title=${escapeProperty(title)}`);
        return `::${level} ${properties.join(',')}::${escapeMessage(message)}`;
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

function buildSurfaceSummary(findings: Finding[]): Record<FindingSurface, number> {
  return {
    source: findings.filter((finding) => finding.surface === 'source').length,
    package: findings.filter((finding) => finding.surface === 'package').length,
    workflow: findings.filter((finding) => finding.surface === 'workflow').length,
    container: findings.filter((finding) => finding.surface === 'container').length
  };
}

function buildSeveritySummary(findings: Finding[]): Record<Severity, number> {
  return {
    critical: findings.filter((finding) => finding.severity === 'critical').length,
    high: findings.filter((finding) => finding.severity === 'high').length,
    medium: findings.filter((finding) => finding.severity === 'medium').length,
    low: findings.filter((finding) => finding.severity === 'low').length
  };
}

function formatSurfaces(surfaces: FindingSurface[]): string {
  if (surfaces.length === 0) {
    return 'none';
  }

  return surfaces.map((surface) => SURFACE_LABELS[surface]).join(', ');
}
