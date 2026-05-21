# CapabilityEcho

[![CI](https://github.com/Conalh/CapabilityEcho/actions/workflows/ci.yml/badge.svg)](https://github.com/Conalh/CapabilityEcho/actions/workflows/ci.yml)
[![CapabilityEcho](https://github.com/Conalh/CapabilityEcho/actions/workflows/capabilityecho.yml/badge.svg)](https://github.com/Conalh/CapabilityEcho/actions/workflows/capabilityecho.yml)
[![Release](https://img.shields.io/github/v/release/Conalh/CapabilityEcho)](https://github.com/Conalh/CapabilityEcho/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Code review for AI agent capability drift in pull requests.

CapabilityEcho is a free OSS CLI and GitHub Action that reviews pull requests for risky **code and workflow changes** that expand what agents can reach — even when agent config files did not change.

- JavaScript and TypeScript network, subprocess, and dynamic-eval signals
- `package.json` lifecycle and pipe-to-shell install scripts
- GitHub Actions write permissions and external network steps
- Terminal, Markdown, JSON, and line-level GitHub annotation output
- GitHub Action step summaries and PR-visible warnings

It is intentionally not a hosted scanner. The Action reads the checked-out repository, uploads nothing by default, and starts advisory with `fail-on: none`.

CapabilityEcho does **not** scan agent config files such as `.mcp.json` or `.claude/settings.json`. Use [ScopeTrail](https://github.com/Conalh/ScopeTrail) for that.

> ScopeTrail catches permission drift in agent config. CapabilityEcho catches capability drift in the code those agents can edit and run.

## Demo

Live demo PR: [Demo: code-only capability drift](https://github.com/Conalh/CapabilityEcho/pull/1)

That PR intentionally adds only application and workflow changes:

- A new `src/telemetry/client.ts` file with an external `fetch()` call.
- A `postinstall` script that pipes a remote installer into `bash`.
- GitHub Actions `contents: write` permission and a `curl` bootstrap step.

No agent config files change, so ScopeTrail would report `none`. CapabilityEcho reports `HIGH` capability drift and emits GitHub warning annotations on the risky lines.

Local fixture with the same scenario:

```powershell
node dist/index.js diff --old test/fixtures/capability-drift/old --new test/fixtures/capability-drift/new --format markdown
```

## Local Use

```powershell
npm install
npm run build
node dist/index.js diff --old test/fixtures/capability-drift/old --new test/fixtures/capability-drift/new --format markdown
```

Compare two git refs:

```powershell
node dist/index.js diff --repo . --base main --head HEAD --format markdown
```

JSON output:

```powershell
node dist/index.js diff --old test/fixtures/capability-drift/old --new test/fixtures/capability-drift/new --format json
```

## GitHub Action

Add this workflow to review code and workflow capability drift on pull requests:

```yaml
name: CapabilityEcho

on:
  pull_request:

permissions:
  contents: read

jobs:
  capabilityecho:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: Conalh/CapabilityEcho@v0.1.0
        with:
          fail-on: none
```

The action uploads nothing by default. It reads local git state from the checked-out repository, writes a Markdown report to the GitHub Actions step summary, and emits PR-visible warning annotations for each finding. Findings point at exact added lines when CapabilityEcho can resolve them.

Start with `fail-on: none` so CapabilityEcho is advisory while you tune policy. Raise it to `high` or `critical` once the findings are trusted.

`fetch-depth: 0` is required because CapabilityEcho compares the pull request base and head refs.

Action outputs:

- `rating`: `none`, `low`, `medium`, `high`, or `critical`
- `finding-count`: total findings in the diff
- `changed-file-count`: number of changed scannable files in the diff

## Current Findings

CapabilityEcho v0 detects:

- External network fetch calls in added JavaScript or TypeScript lines.
- Subprocess or shell spawn calls in added JavaScript or TypeScript lines.
- Dynamic code execution such as `eval()` or `new Function()` in added lines.
- GitHub Actions write permissions in added workflow lines.
- External network requests in added workflow steps.
- Workflow steps that combine secrets or env values with external requests.
- Added or changed npm lifecycle scripts such as `postinstall`.
- Pipe-to-shell install scripts in `package.json`.
- Network or publish commands in npm scripts.

## Complements ScopeTrail and PolicyMesh

Use the suite together:

- **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** — did agent permissions **change** in this PR?
- **[PolicyMesh](https://github.com/Conalh/PolicyMesh)** — do agent surfaces **agree** in this repo right now?
- **CapabilityEcho** — did the **code or workflow diff** introduce new capability signals?

## Feedback Wanted

CapabilityEcho is intentionally small right now. If a warning is noisy, open a
[false-positive report](https://github.com/Conalh/CapabilityEcho/issues/new?template=false-positive.yml).
If your team uses another capability signal, open a
[missing-signal request](https://github.com/Conalh/CapabilityEcho/issues/new?template=missing-signal.yml).

## Development

```powershell
npm install
npm run build
npm test
```
