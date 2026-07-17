# CapabilityEcho

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](package.json)
[![Local-only](https://img.shields.io/badge/runs-local%20only-2ea44f)](#how-it-works)
[![Release](https://img.shields.io/github/v/release/Conalh/CapabilityEcho)](https://github.com/Conalh/CapabilityEcho/releases)
[![npm](https://img.shields.io/npm/v/capabilityecho)](https://www.npmjs.com/package/capabilityecho)

**A code-diff capability detector for AI-agent pull requests.** CapabilityEcho flags new network, subprocess, eval, lifecycle, dependency, Dockerfile, and workflow-permission signals introduced by the code itself, not the agent config.

Agent config can stay unchanged while the diff adds a `fetch('https://...')`, a `postinstall` script, a `contents: write` workflow, or a subprocess path that makes the agent's output more powerful than the task implied. CapabilityEcho makes that executable capability drift visible on the exact added lines.

```mermaid
flowchart LR
    Diff["PR diff<br/>added lines"] --> Echo
    Source["Source code<br/>JS · TS · Python"] --> Echo
    Manifests["Manifests + workflows<br/>package · lockfiles · Actions · Docker"] --> Echo
    Echo[("CapabilityEcho<br/>capability drift scan")] --> Report["Review output<br/>annotations · markdown · JSON"]
    Report --> Reviewer["Reviewer sees<br/>new executable power"]

    classDef input fill:#1e293b,stroke:#334155,color:#e2e8f0
    classDef engine fill:#0f172a,stroke:#1e293b,color:#e2e8f0,stroke-width:2px
    classDef output fill:#0c4a6e,stroke:#0369a1,color:#e0f2fe
    class Diff,Source,Manifests input
    class Echo engine
    class Report,Reviewer output
```

**See also:** [ScopeTrail](https://github.com/Conalh/ScopeTrail) for config drift · [TaskBound](https://github.com/Conalh/TaskBound) for task-vs-diff scope creep · [GovVerdict](https://github.com/Conalh/GovVerdict) for one merged suite verdict.

**Quick start** — compare two refs in an existing repository:

```bash
npx capabilityecho@0.3.4 diff --repo . --base main --head HEAD --format markdown
```

Prefer CI? A drop-in GitHub Action (advisory by default) and a real fixture run are in the Quickstart and Example output below.

## Where this fits

CapabilityEcho is the **capability-drift** detector — it flags code that gains new executable power on the exact lines a PR added.

| Tool | Input | Catches / decides | Output | Use when |
|---|---|---|---|---|
| [warden](https://github.com/Conalh/warden) | policy + tool action | allow / deny / ask | verdict | you need deterministic runtime policy decisions |
| [barbican](https://github.com/Conalh/barbican) | MCP tools/list + tools/call | denied calls, ask handling, tool poisoning | enforced MCP proxy + reports | you need MCP runtime enforcement |
| [ScopeTrail](https://github.com/Conalh/ScopeTrail) | PR base/head agent config | permission/config drift | annotations + report | a PR changes agent config |
| [PolicyMesh](https://github.com/Conalh/PolicyMesh) | current repo policy/config files | contradictory rules across agent surfaces | report / SARIF | current policy is inconsistent |
| **CapabilityEcho** | PR diff | new executable capability | annotations + report | code gains network/subprocess/eval/lifecycle/workflow power |
| [TaskBound](https://github.com/Conalh/TaskBound) | stated task + PR diff | scope creep | annotations + report | an agent may have gone off-task |
| [SessionTrail](https://github.com/Conalh/SessionTrail) | Cursor/Claude/Codex JSONL transcripts | risky runtime behavior | report / SARIF | an agent session already ran |
| [GovVerdict](https://github.com/Conalh/GovVerdict) | JSON reports | deduped suite verdict | merged report | you want one final review verdict |
| [AgentPulse](https://github.com/Conalh/AgentPulse) | live session events | trajectory state | terminal dashboard | you want live session observation |
| [agent-gov-core](https://github.com/Conalh/agent-gov-core) | shared schemas/parsers | common Finding/Report model | library | tools need shared report primitives |

## Why this exists

A PR does not need to edit `.mcp.json` or `.claude/settings.json` to expand what an agent-produced change can do. It can add network calls, subprocess execution, lifecycle scripts, workflow permissions, or high-capability dependencies directly in code.

CapabilityEcho exists to make those new executable capabilities reviewable. It does not decide whether a capability is always bad; it points reviewers to the exact line where the diff gained new power.

## What it catches

| Drift class | Example |
| --- | --- |
| **Network capability** | Added `fetch`, HTTP clients, dynamic endpoint calls, workflow/composite-action `curl`, or networky npm scripts. |
| **Subprocess capability** | Added shell/process execution, dynamic command construction, shell pipelines, or extensionless shebang scripts. |
| **Lifecycle capability** | `postinstall`, publish scripts, pipe-to-shell installers, or package hooks. |
| **Workflow capability** | New write permissions, external requests, secret exposure patterns, risky PR-target flows. |
| **Dependency capability** | New high-capability packages or lockfile changes that introduce sensitive behavior. |

## How well it catches it (and what the numbers do *not* mean)

CapabilityEcho ships a labeled corpus of 34 before/after PR snapshots — 20 rogue
(a new capability quietly added) and 14 benign adversarial near-misses (same-origin
`fetch`, `yaml.safe_load`, ordinary dep adds, refactors).

| Metric | Value |
| --- | --- |
| Cases | 34 (20 rogue, 14 benign) |
| Detection recall on this committed corpus (any finding) | 100.0% |
| False-positive rate on this committed benign corpus | 0.0% |
| Precision on this committed corpus | 100.0% |
| Recall at `--fail-on=high` CI gate | 85.0% |
| Correct primary capability identified | 20/20 |

**Read this as a specification and regression suite, not an evaluation against
independent ground truth.** The detectors and the fixtures share an author, so
100% precision / 0% FP means the detectors do what they were designed to do and
keep doing it across changes — it does *not* show they catch what real agents or
adversaries produce in the wild. Each rogue fixture is also a single, textbook
pattern instance; real PRs are messier. Treat these numbers as "the tool behaves
to spec," and read [Threat model and limits](#threat-model-and-limits) for what
that spec deliberately does and does not cover.

The 85% at a `high` gate is calibration, not a miss: three rogue cases (an external
`fetch`, a Python `requests.get`, a `wget` download) are genuinely *medium*-severity
— gate on `medium` to fail CI on every rogue case in the corpus.

`npm run benchmark` is a gating regression check: it fails if a rogue fixture is
missed, a benign fixture is flagged, an expected kind/severity is lost, the
fixture generator drifts from committed fixtures, or the git-mode / bundled
Action probes fail.

Reproduce with `npm run benchmark`. Methodology and the full corpus live in
[`benchmark/`](benchmark/README.md); the regenerated report is
[`benchmark/RESULTS.md`](benchmark/RESULTS.md).

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
      - uses: Conalh/CapabilityEcho@v0.3.4
        with:
          fail-on: none           # start advisory, raise to high/critical later
```

This writes a Markdown report to the Actions step summary and emits PR-visible `::warning` annotations on the risky lines.

### Local CLI

```powershell
# Run without installing globally
npx capabilityecho@0.3.4 diff --repo . --base main --head HEAD --format text

# Or install the CLI
npm install --global capabilityecho@0.3.4

# Compare two directories
capabilityecho diff `
  --old test/fixtures/capability-drift/old `
  --new test/fixtures/capability-drift/new `
  --format markdown

# Compare two git refs in a real repo
capabilityecho diff --repo . --base main --head HEAD --format text
```

CapabilityEcho requires Node 22 or newer. CI exercises Node 22 and 24.

To build from source or contribute detector coverage, see [CONTRIBUTING.md](CONTRIBUTING.md).

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
      "fingerprint": "..."
    }
  ],
  "data": { "changedFileCount": 3, "scannedSurfaces": ["source", "package", "workflow"] }
}
```

## How it works

- Runs against the **checked-out repo** — no upload, no hosted scanner, no telemetry.
- Resolves the diff (`--old`/`--new` directories, or `--base`/`--head` git refs) and inspects **added lines** across source code (`.js/.ts/.mjs/.cjs/.mts/.cts`, Python, shell, extensionless shell shebangs), package manifests + lockfiles, GitHub workflows/composite actions, and Dockerfile/Containerfile builds.
- Fires small, explicit detectors for patterns that expand capability: external network calls, subprocess/shell spawns, dynamic `eval`/`exec`, unsafe deserialization, high-capability deps, npm lifecycle and pipe-to-shell scripts, workflow write permissions and external requests, secret-tainted exfil patterns.
- Workflows get a structural YAML pass backed by a line pass for shell text inside `run:` blocks.
- Findings carry severity, file + line, and a recommendation. The action exits non-zero only when `fail-on` is met.
- Checked-in exception baselines from the trusted base revision can suppress known findings. PR-local exception policy changes are reported visibly and take effect only after merge.

CapabilityEcho does **not** scan agent config files like `.mcp.json` or `.claude/settings.json`; that is [ScopeTrail](https://github.com/Conalh/ScopeTrail)'s lane. The two are designed to run together.

## Exception baselines

CapabilityEcho auto-loads `.capabilityecho-exceptions.json` from the trusted base side of the diff (`--old` in directory mode, `--base` in git mode). You can override the path with `--exceptions <path>` or the Action `exceptions-file` input.

If a PR adds, deletes, or edits the exception file, that candidate policy is not applied to the same analysis. The change is reported as `capability_echo.exception_policy_changed` and takes effect only after merge, when it becomes part of the trusted base revision.

```json
{
  "exceptions": [
    {
      "kind": "capability_echo.external_fetch_added",
      "pathPrefix": "src/vendor/",
      "expires": "2026-12-31",
      "reason": "Legacy vendor updater is approved until replacement lands."
    }
  ]
}
```

Rules use the shared `agent-gov-core` exception shape: `kind` is required; `salientKey` and `pathPrefix` narrow the match; `expires` makes stale exceptions visible; `reason` is required by CapabilityEcho so every suppression has a checked-in justification. Active matches are removed from findings, counted as `suppressedFindingCount`, and recorded in `data.suppressedFindings` with fingerprint, kind, location, reason, and expiry. Expired matches do not lower the original finding severity; the original finding remains visible at its original severity and a separate low-severity `capability_echo.exception_expired` finding explains the expired exception with `data.exceptionReason`.

Invalid exception files do not suppress anything. They mark `analysisIncomplete`, add an `exception_config_error` diagnostic, and keep all findings visible. Candidate-side invalid exception changes are reported but are not applied. Input-read and parser diagnostics are not findings and cannot be suppressed by exception rules.

## Threat model and limits

**CapabilityEcho is built for the careless-but-honest author, not the motivated
evader.** It catches capability drift from naive agents and ordinary mistakes —
code that gains real new power and is written the obvious way. It is *not* an
adversarial control: regex-over-added-lines is trivially defeated by anyone who
wants to defeat it (indirection, aliasing, computed member access, string
concatenation, base64, `require`-by-variable). If your threat is a deliberately
evasive author, this tool is the wrong layer — push enforcement to runtime
([warden](https://github.com/Conalh/warden), [barbican](https://github.com/Conalh/barbican)),
where capability is observed rather than pattern-matched.

Concrete limits worth knowing before you trust a verdict:

- **Severity and evadability are inversely correlated here.** The highest-severity
  classes are the easiest to slip past. Secret-exfil is the clearest case: the most
  natural real pattern is a URL or token defined in an *unchanged* file and merely
  referenced in the diff — and CapabilityEcho does not do cross-file taint, so it
  never sees the source. A *clean* CapabilityEcho run is not evidence that no
  exfiltration path exists; it is evidence that none was introduced in the obvious,
  single-file, added-line way.
- **JS/TS and Python are matched textually, not structurally.** Workflows get a
  structural YAML pass, but source detectors are pattern-based. They catch literal
  external URLs, added dynamic endpoint variables, and some same-file continuation
  arguments, but aliased imports, destructuring, and complex member-expression call
  targets can still be missed. Closing this is on the roadmap (see below).
- **Added-line bias by design.** Capability that already existed in the base, or
  that is reachable only through unchanged code, is out of scope on purpose.
- **Package lockfile support is npm `package-lock.json` only today.** Yarn,
  pnpm, Bun, Poetry, and uv lockfile formats are backlog items; dependency
  manifest scanning still covers `package.json`, `requirements*.txt`, and
  `pyproject.toml` direct declarations.

## Design choices worth flagging

- **Code, not config.** The tool catches capabilities introduced by executable artifacts even when the agent policy surface did not change.
- **Added-line bias.** Findings stay tied to what the PR introduced, which keeps review focused on the current change.
- **Small detectors.** The scanner is intentionally explicit and explainable instead of pretending to be a full semantic security engine.
- **Suite-shaped output.** JSON uses the shared `Finding` contract so GovVerdict can merge it with the rest of the agent-gov tools.
- **Roadmap: structural source parsing.** Workflows are already parsed structurally; JS/TS (`typescript` is a dependency) and Python source are next, to resolve aliased imports, destructuring, and member-expression call targets instead of matching them textually. This closes a class of single-file bypasses at once — it does not address cross-file taint, which is a separate, larger effort.

## Options

### CLI flags (`capabilityecho diff ...`)

| Flag | Default | Purpose |
| --- | --- | --- |
| `--old <dir>` / `--new <dir>` | — | Directory-mode diff. |
| `--repo <path>` / `--base <ref>` / `--head <ref>` | repo = cwd | Git-mode diff between two refs in a real repo. |
| `--exceptions <path>` | `.capabilityecho-exceptions.json` when present | Repo-relative JSON exception baseline loaded from the old directory or base ref. |
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
| `exceptions-file` | `.capabilityecho-exceptions.json` when present | Repo-relative JSON exception baseline loaded from the trusted base ref. |

### GitHub Action outputs

`rating`, `has-findings`, `finding-count`, `changed-file-count`, `analysis-incomplete`, `analysis-diagnostic-count`, `analysis-diagnostics`, `suppressed-finding-count`, `expired-exception-count`, `surface-summary`, `severity-summary`, `capability-summary`, `top-recommendations`, `adoption-evidence`, `report-markdown`, `report-json`.

## Part of the agent-gov suite

Local-only OSS tools that review AI-agent PRs and coding sessions for config drift, policy mismatches, and scope creep. Each tool covers an orthogonal failure mode; they share a canonical `Finding` schema and can be merged into a single verdict.

| Repo | What it catches |
| --- | --- |
| [ScopeTrail](https://github.com/Conalh/ScopeTrail) | Agent config drift between PR base and head. |
| [PolicyMesh](https://github.com/Conalh/PolicyMesh) | Contradictory agent instructions and config drift that make behavior non-reproducible. |
| **CapabilityEcho** *(this repo)* | Capability drift introduced by code, manifests, workflows, and Dockerfiles. |
| [TaskBound](https://github.com/Conalh/TaskBound) | Scope creep between the stated task and the actual diff. |
| [SessionTrail](https://github.com/Conalh/SessionTrail) | Risky runtime behavior in Cursor / Claude Code / Codex session transcripts. |
| [GovVerdict](https://github.com/Conalh/GovVerdict) | Merges JSON reports from the tools above into one deduped review. |
| [agent-gov-core](https://github.com/Conalh/agent-gov-core) | Shared parsers, the canonical `Finding` schema, and `mergeFindings`. |
| [agent-gov-demo](https://github.com/Conalh/agent-gov-demo) | Demo sandbox with a rogue PR that fires all five reviewers. |

MIT. Bug reports and false-positive reports are welcome via [Issues](https://github.com/Conalh/CapabilityEcho/issues). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
