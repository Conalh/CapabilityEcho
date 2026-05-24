# CapabilityEcho

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)
[![Local-only](https://img.shields.io/badge/runs-local%20only-2ea44f)](#how-it-works)
[![Release](https://img.shields.io/github/v/release/Conalh/CapabilityEcho)](https://github.com/Conalh/CapabilityEcho/releases)

**Flags new network, subprocess, eval, and workflow-permission signals that an AI agent's PR introduces into the code itself — not its config.**

## The problem

An agent's `.mcp.json` and `.claude/settings.json` can look unchanged while the PR adds a `fetch('https://…')` to a new file, a `postinstall` script that pipes a remote installer into bash, or a workflow that grants `contents: write` and curls a secret out. The agent didn't ask for new permissions — it just *wrote code that uses them*. CapabilityEcho diffs the PR and flags those signals on the exact added lines, so capability drift through code is as visible as capability drift through config.

## Quickstart

### As a GitHub Action (most common)

```yaml
name: CapabilityEcho
on: pull_request
permissions:
  contents: read

jobs:
  capabilityecho:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0          # required: PR base + head are compared
      - uses: Conalh/CapabilityEcho@v0.2.1
        with:
          fail-on: none           # start advisory, raise to high/critical later
```

This writes a Markdown report to the Actions step summary and emits PR-visible `::warning` annotations on the risky lines.

### Local CLI

```powershell
git clone https://github.com/Conalh/CapabilityEcho
cd CapabilityEcho
npm install
npm run build

# Compare two directories (fastest way to try it on the bundled fixture)
node dist/index.js diff `
  --old test/fixtures/capability-drift/old `
  --new test/fixtures/capability-drift/new `
  --format markdown

# Compare two git refs in a real repo
node dist/index.js diff --repo . --base main --head HEAD --format text
```

<!-- TODO: add screenshot or asciinema GIF of real terminal output here -->

## Example output

Real output from the bundled fixture, `--format text`:

```
CapabilityEcho capability drift: CRITICAL
Scanned executable surfaces: source code, package manifests, GitHub workflows.
Excluded surfaces: AI-agent config.
Signals: GitHub Actions workflow-level write permissions, workflow external network requests,
  external network fetch calls, npm lifecycle scripts, pipe-to-shell install scripts,
  network or publish npm scripts
Top recommendations: Replace remote pipe-to-shell patterns with pinned, reviewable install steps.
  | Use the narrowest permission scope required for this job.
  | Review lifecycle scripts carefully; they run automatically on install.
[HIGH]     GitHub Actions workflow-level write permission (contents) — contents:write applies to every job
[MEDIUM]   Workflow external request — step performs an external network request
[MEDIUM]   External network fetch — added code performs an external HTTP request
[HIGH]     package.json postinstall script — added or changed npm lifecycle script
[CRITICAL] package.json postinstall pipe-to-shell — script pipes remote content into a shell
[MEDIUM]   package.json postinstall network command
```

`--format json` emits the canonical [agent-gov-core](https://github.com/Conalh/agent-gov-core) `Report` envelope — the same shape every tool in the suite emits, so [GovVerdict](https://github.com/Conalh/GovVerdict) can merge them:

```json
{
  "schemaVersion": "1.0",
  "tool": "capability_echo",
  "rating": "critical",
  "findings": [
    {
      "tool": "capability_echo",
      "kind": "capability_echo.script_pipe_to_shell",
      "severity": "critical",
      "message": "Script downloads and pipes content directly into a shell.",
      "location": { "file": "package.json", "line": 12 },
      "salientKey": "package.json postinstall pipe-to-shell",
      "data": {
        "subject": "package.json postinstall pipe-to-shell",
        "recommendation": "Replace remote pipe-to-shell patterns with pinned, reviewable install steps.",
        "surface": "package"
      },
      "fingerprint": "…"
    }
  ],
  "data": { "changedFileCount": 3, "scannedSurfaces": ["source", "package", "workflow"], "…": "…" }
}
```

## How it works

- Runs against the **checked-out repo** — no upload, no hosted scanner, no telemetry.
- Resolves the diff (`--old`/`--new` directories, or `--base`/`--head` git refs) and inspects **added lines** across four surfaces: source code (JS/TS/Python), package manifests + lockfiles, GitHub workflows, and Dockerfiles.
- For each surface, a small set of detectors fire on patterns that expand capability: external network calls, subprocess/shell spawns, dynamic `eval`/`exec`, unsafe deserialization, newly-added high-capability deps, npm lifecycle and pipe-to-shell scripts, workflow write permissions and external requests, secret-tainted exfil patterns.
- Workflows get a structural YAML pass (job-level vs workflow-level scopes, `secrets.*` env precedence, `pull_request_target` + PR-head checkout) backed by a line pass for shell text inside `run:` blocks.
- Findings carry severity, file + line, and a recommendation. The action exits non-zero only when `fail-on` is met.

What it does **not** do: scan agent config files (`.mcp.json`, `.claude/settings.json`, etc.) — that's [ScopeTrail](https://github.com/Conalh/ScopeTrail)'s job. The two are designed to be run together.

## Options

### CLI flags (`capabilityecho diff …`)

| Flag | Default | Purpose |
| --- | --- | --- |
| `--old <dir>` / `--new <dir>` | — | Directory-mode diff. |
| `--repo <path>` / `--base <ref>` / `--head <ref>` | repo = cwd | Git-mode diff between two refs in a real repo. |
| `--format` | `text` | `text`, `markdown`, `json` (canonical envelope), `github` (annotations). |
| `--fail-on` | `none` | Exit non-zero if the highest finding meets this severity: `none`, `low`, `medium`, `high`, `critical`. |

### GitHub Action inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `repo` | `$GITHUB_WORKSPACE` | Checkout path to inspect. |
| `base` / `head` | PR base / head | Override the refs being compared. |
| `fail-on` | `none` | Severity that fails the job. |
| `max-findings` | `0` (unlimited) | Truncate Action outputs + step summary to top-N by severity. Rating and `fail-on` still use the full set. |
| `max-output-bytes` | `0` (unlimited) | Suppress `report-markdown` / `report-json` Action outputs over this size (step summary kept). |
| `report-file` | _empty_ | Path to write the full Markdown report (plus a sibling `.json`). Pair with `actions/upload-artifact`. |

### GitHub Action outputs

`rating`, `has-findings`, `finding-count`, `changed-file-count`, `surface-summary`, `severity-summary`, `capability-summary`, `top-recommendations`, `adoption-evidence`, `report-markdown`, `report-json`.

## Part of the agent-gov suite

Local-only OSS tools that review AI-agent PRs and coding sessions for config drift, policy mismatches, and scope creep. Each tool covers an orthogonal failure mode; they share a canonical `Finding` schema and can be merged into a single verdict.

| Repo | What it catches |
| --- | --- |
| **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** | Diffs agent config files between PR base and head — permission drift. |
| **[PolicyMesh](https://github.com/Conalh/PolicyMesh)** | Audits MCP / Claude / Codex configs for contradictions across surfaces. |
| **CapabilityEcho** *(this repo)* | Network, subprocess, eval, lifecycle, and workflow-permission signals in code diffs. |
| **[TaskBound](https://github.com/Conalh/TaskBound)** | Compares the stated task to the actual diff — scope creep. |
| **[SessionTrail](https://github.com/Conalh/SessionTrail)** | Parses Cursor / Claude / Codex JSONL session transcripts for runtime behavior. |
| **[GovVerdict](https://github.com/Conalh/GovVerdict)** | Merges JSON reports from the tools above into a single verdict. |
| **[agent-gov-core](https://github.com/Conalh/agent-gov-core)** | Shared parsers, the canonical `Finding` schema, `mergeFindings`. |
| **[agent-gov-demo](https://github.com/Conalh/agent-gov-demo)** | Sandbox repo with a rogue PR that exercises all five tools end-to-end. |

**Demo PR exercising the full stack:** [agent-gov-demo#1](https://github.com/Conalh/agent-gov-demo/pull/1)

---

MIT. Bug reports and false-positive reports welcome via [Issues](https://github.com/Conalh/CapabilityEcho/issues).
