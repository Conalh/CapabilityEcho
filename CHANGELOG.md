# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may carry breaking changes.

## [Unreleased]

### Changed
- Updated the pinned GitHub runner actions and the npm production/development toolchain, including TypeScript 7 and agent-gov-core 1.4.0.
- The Action bundle now consumes the JavaScript emitted by `tsc`, keeping the compiler and bundler boundaries compatible as TypeScript moves to its native toolchain.
- Removed public dogfood workflows that could no longer resolve the now-private ScopeTrail and TaskBound actions.

## [0.3.4] - 2026-07-16

### Added
- Published the CapabilityEcho CLI to npm for direct `npx capabilityecho` and global-install use.
- Added `capabilityecho --version`, contributor guidance, a security policy, and Dependabot coverage for npm and GitHub Actions.

### Changed
- Centralized workflow and package-manifest classification so detectors share one discovery contract instead of drifting across implementations.
- The README now leads local users through the published CLI while retaining source-build instructions for contributors.

### Included from 0.3.3
- Checked-in exception baselines load from the trusted base revision and cannot be widened by the candidate PR to suppress its own findings.
- Active suppressions, expired exceptions, invalid policy diagnostics, and exception-policy changes are visible in CLI, JSON, and GitHub Action output.

## [0.3.3] - 2026-06-21

### Security
- **Exception baselines now apply from the trusted base revision, not the candidate PR revision.** A PR can add, remove, or widen `.capabilityecho-exceptions.json`, but that candidate policy is reported as `capability_echo.exception_policy_changed` and cannot suppress findings from the same diff.
- **Expired exceptions no longer lower the original finding severity.** When every matching exception is expired, CapabilityEcho keeps the original finding at its original severity and emits a separate low-severity `capability_echo.exception_expired` finding to explain the stale exception.

### Changed
- JSON report data now includes `suppressedFindings`, with each active suppression recording fingerprint, kind, location, reason, and expiry alongside the existing suppression counts.
- README and Action metadata now state the Node 22+ support floor and the trusted-base exception semantics.

### Verification
- Added regression coverage for trusted-base exception application, PR-local exception self-suppression, expired-exception severity preservation, invalid exception fail-closed behavior, canonical report validation, fingerprint stability, Action suppression metadata, and Node 22/24 CI support.

## [0.3.2] — 2026-05-28

### Security
- **Added the git-ref argument-injection guard the detector was missing.** Git mode now rejects refs that git would re-parse as CLI flags (`-`-leading, e.g. `--upload-pack=...`) or as `ref:path` object selectors (containing `:`), plus control characters, before any `git` subprocess runs. Previously only `rev-parse --verify` stood between an untrusted ref and git. The guard is the shared `isValidGitRef` from agent-gov-core 1.3.0; an injection-vector ref now surfaces as a clean `GitDiffSetupError`.
- **Directory-mode walks now skip files larger than the shared 10 MiB input cap** (`withinByteCap`), so a single huge file in an untrusted tree can't exhaust memory when read and scanned. Applies to both the source walk and the `package.json` walk.

### Internal
- Directory-mode path joins now go through core `resolveWithinRoot` for explicit root-containment (defense-in-depth alongside the existing symlink skip). Bumped `agent-gov-core` `^1.2.1` → `^1.3.0`.

## [0.3.1] — 2026-05-28

### Security
- **Directory mode no longer follows symlinks out of the scanned tree.** When invoked with `--old`/`--new` (directory comparison), the file walk treated symlinked entries like any other file and read their targets, so a symlink committed into an untrusted tree could point at `/etc/passwd` or a sibling checkout and leak that content into finding evidence. Both directory walks (`listScannableFiles` and `listPackageJsonFiles`) now skip symlinked entries. Git mode (`git show <ref>:<path>`) was never affected; detection on legitimate trees is unchanged.

## [0.3.0] — 2026-05-28

### Changed
- **GitHub annotations are now severity-aware.** `high` and `critical` findings emit `::error` annotations; `medium` and `low` stay `::warning`. This matches the annotation contract in agent-gov-core (and GovVerdict), so a critical capability drift no longer shows up as a yellow warning in the PR diff. Exit-code gating is unchanged — that is still controlled by `--fail-on`.

### Added
- Labeled precision/recall benchmark over the capability-drift fixture corpus (`npm run benchmark`).

### Internal
- Bumped `agent-gov-core` dependency `^1.0.0` → `^1.2.1`.

## [0.2.1] — 2026-05-22

### Fixed
- **Action runtime: the bundled JS Action was a no-op in CI.** When CapabilityEcho was invoked as a GitHub Action via `uses: Conalh/CapabilityEcho@v0.2.0`, Node loaded the bundle but never invoked `mainAction`: zero log output, no `report-file` written, scalar outputs empty, exit code 0. The entrypoint guard in `src/action.ts` was `process.argv[1]?.endsWith('action.js')`, which matched the tsc-compiled `dist/action.js` (used by the test suite) but not the ncc-bundled `dist/action-bundle/index.js` that `action.yml` actually points at. Replaced with an `import.meta.url`-based comparison that fires for both entrypoints. CLI behavior (`bin/capabilityecho`) and `--format` outputs are unchanged; only the Action runtime path was broken.

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
