# CapabilityEcho

[![CI](https://github.com/Conalh/CapabilityEcho/actions/workflows/ci.yml/badge.svg)](https://github.com/Conalh/CapabilityEcho/actions/workflows/ci.yml)
[![CapabilityEcho](https://github.com/Conalh/CapabilityEcho/actions/workflows/capabilityecho.yml/badge.svg)](https://github.com/Conalh/CapabilityEcho/actions/workflows/capabilityecho.yml)
[![Release](https://img.shields.io/github/v/release/Conalh/CapabilityEcho)](https://github.com/Conalh/CapabilityEcho/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Code review for AI agent capability drift in pull requests.

CapabilityEcho is a free OSS CLI and GitHub Action that reviews pull requests for risky **code and workflow changes** that expand what agents can reach — even when agent config files did not change.

- JavaScript, TypeScript, **and Python** network, subprocess, and dynamic-eval signals
- `package.json` lifecycle and pipe-to-shell install scripts
- GitHub Actions write permissions and external network steps
- Terminal, Markdown, JSON, and line-level GitHub annotation output
- GitHub Action step summaries and PR-visible warnings

It is intentionally not a hosted scanner. The Action reads the checked-out repository, uploads nothing by default, and starts advisory with `fail-on: none`.

CapabilityEcho does **not** scan agent config files such as `.mcp.json` or `.claude/settings.json`. Use [ScopeTrail](https://github.com/Conalh/ScopeTrail) for that.

> ScopeTrail catches permission drift in agent config. CapabilityEcho catches capability drift in the code those agents can edit and run.

## Part of an AI-agent governance suite

Five tools mapping orthogonal failure modes of AI-agent deployment:

- **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** — config drift over time (PR-level).
- **[PolicyMesh](https://github.com/Conalh/PolicyMesh)** — policy contradictions across agent surfaces.
- **CapabilityEcho** *(this repo)* — capability drift via code, not config.
- **[TaskBound](https://github.com/Conalh/TaskBound)** — scope creep after the agent runs.
- **[SessionTrail](https://github.com/Conalh/SessionTrail)** — runtime behavior review across agent session transcripts.

ScopeTrail, PolicyMesh, and CapabilityEcho are preventive (static analysis of config and code). SessionTrail is runtime (in-session transcript review). TaskBound is detective (stated task vs. actual diff).

## Demo

Live demo PR: [Demo: code-only capability drift](https://github.com/Conalh/CapabilityEcho/pull/1)

That PR intentionally adds only application and workflow changes:

- A new `src/api/sync.ts` file with an external `fetch()` call.
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

Optional inputs for very large diffs:

- `max-findings` (default `0` = unlimited): truncate the on-action markdown/json outputs and step summary to the top-N findings ranked by severity. `rating`, `finding-count`, and the `fail-on` decision are still computed against the full set.
- `max-output-bytes` (default `0` = unlimited): suppress the `report-markdown` and `report-json` action outputs (only — the step summary is left intact) when they exceed this byte size, replacing them with a short notice. Useful to stay inside GitHub Actions output limits.
- `report-file` (default empty): repo-relative or absolute path to write the **full** markdown report. A sibling `<path>.json` is also written. Pair with `actions/upload-artifact` to keep a complete record alongside a truncated PR view.

## Current Findings

CapabilityEcho v0 detects:

- External network fetch calls in added JavaScript or TypeScript lines.
- Subprocess or shell spawn calls in added JavaScript or TypeScript lines.
- Dynamic code execution such as `eval()` or `new Function()` in added lines.
- **Python equivalents:** `requests`/`httpx`/`urllib` network calls (URL-gated), `subprocess`/`os.system`/`os.popen`/`pty.spawn`, `eval`/`exec`/`compile`/`__import__`/`importlib.import_module`, and unsafe deserialization (`pickle.load`, `marshal.load`, `yaml.load` without `SafeLoader`).
- **Newly-added dependencies with high capability surface:** headless browsers (`puppeteer`, `playwright`, `cypress`), subprocess/PTY wrappers (`execa`, `cross-spawn`, `node-pty`, `shelljs`, `zx`), arbitrary HTTP clients (`node-fetch`, `undici`, `got`, `axios`), VM/eval libraries (`vm2`, `isolated-vm`), and SSH/proxy primitives. Telemetry SDKs are flagged at medium.
- **Python dependency manifests:** added high-capability deps in `requirements.txt`, `pyproject.toml` (PEP 621 and Poetry), and `Pipfile` — HTTP clients (`requests`, `httpx`, `aiohttp`), browser automation (`playwright`, `selenium`), subprocess/SSH wrappers (`sh`, `pexpect`, `paramiko`, `fabric`), and dynamic-eval libraries.
- **npm lockfile (`package-lock.json`, `npm-shrinkwrap.json`):** transitive high-capability dep additions and newly-added packages declaring install/postinstall scripts.
- GitHub Actions write permissions in added workflow lines.
- External network requests in added workflow steps.
- Workflow steps that combine secrets or env values with external requests.
- Added or changed npm lifecycle scripts such as `postinstall`.
- Pipe-to-shell install scripts in `package.json`.
- Network or publish commands in npm scripts.

## Detection limits

CapabilityEcho v0 inspects added diff lines, with a full-file pass for secret-variable
collection in changed JS and Python files. A few patterns are still structurally
bypassable today:

- **Same-line URL requirement.** Inline network detection for *high-level*
  clients (fetch, axios, requests, httpx, urllib) gates on `https?://` (or a
  variable substitution in workflow lines). The detector also looks at the
  next few added lines for a URL or secret reference, so split-line
  `fetch(\n  'https://…',\n  …\n)` constructs are flagged. Low-level
  primitives (`http.client`, `socket.socket`, `https.get`, `paramiko`, etc.)
  fire without requiring a URL on the same line.
- **No cross-file taint.** A new call site that references a URL or secret defined
  in an existing (unchanged) file is not tainted today.
- **Partial npm lockfile coverage.** `package-lock.json` (and `npm-shrinkwrap.json`)
  are scanned for transitive high-capability dep additions and newly-added
  packages declaring an install script. `pnpm-lock.yaml` and `yarn.lock` are not
  scanned today.
- **Workflow scanning is line-based, not YAML-structural.** Comment lines are
  filtered, but `run:`/`uses:`/`with:` are matched by regex rather than by
  YAML tree position. Reasoning about workflow structure (job-level
  permissions, `with.ref`, env precedence) is future work.

Bypass closures land regularly — see [`test/fixtures/bypasses/`](test/fixtures/bypasses)
for the corpus of patterns the detector has been hardened against.

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

Shared parsing, locators, and the Finding schema live in [agent-gov-core](https://github.com/Conalh/agent-gov-core) — see its [CONTRIBUTING.md](https://github.com/Conalh/agent-gov-core/blob/main/CONTRIBUTING.md) before touching that library.
