# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may carry breaking changes.

## [0.2.0] — 2026-05-22

**BREAKING** — JSON output now emits the canonical agent-gov-core `Report` envelope so the cross-tool meta-reviewer (GovVerdict) can ingest one shape across the whole suite.

### Changed (breaking)
- `--format json` output replaces the legacy `EchoReport` shape with the canonical `Report` envelope: `{ schemaVersion: '1.0', tool: 'capability_echo', rating, findings, data: { changedFileCount, scannedSurfaces, excludedSurfaces, surfaceSummary, severitySummary, capabilitySummary, topRecommendations } }`. The aggregate rating remains accessible at `.rating` (same path); the previous `.findingCount` is now `.findings.length`; CapabilityEcho-specific extras move under `.data.*`.
- Each emitted finding moves flat `file` / `line` into `location: { file, line }` per the canonical `Finding` schema. CapabilityEcho-specific extras (`subject`, `recommendation`, `surface`) ride along under `data.*` per finding.
- The `report-json` Action output picks up the new shape automatically (it's just `renderReport(report, 'json')`). All scalar Action outputs (`rating`, `finding-count`, `surface-summary`, etc.) are unchanged — they're computed from the in-memory `EchoReport`, not the serialized JSON.

### Why
- Closes the envelope mismatch that forced GovVerdict to carry a legacy adapter in `src/load.ts`. After all five consumers migrate, the adapter is deleted in GovVerdict v0.2.0.
- Unblocks the agent-gov-core v1.0 schema freeze: every consumer now flows through `createReport` + `createFinding`, so the canonical envelope is the only contract downstream tools depend on.

### Internal
- Internal `EchoReport` type retained — markdown / text / GitHub annotation renderers and the action-bundle entry all continue to consume it directly.
