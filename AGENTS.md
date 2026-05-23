# CapabilityEcho — agent spine

Free OSS CLI and GitHub Action that reviews pull requests for **capability drift**: code and workflow changes that expand what an AI agent can reach (network, subprocess, dynamic eval, dependency surface, CI permissions) — even when no agent config files changed.

CapabilityEcho is *intentionally not* a hosted scanner. It runs locally or in CI on a git diff, reads the checked-out repo, and uploads nothing by default.

## Where things live

- `src/detectors/*.ts` — one file per surface (JS/TS, Python, workflows, packages, shell, dockerfile). Each exports a `detect*` function returning `Finding[]`.
- `src/diff.ts` — orchestrates all detectors against an added-line diff.
- `src/paths.ts` — `surfaceForPath`, `isCommentLine`, language gates, and the `EXCLUDED_PATHS` allowlist (agent config files we deliberately do *not* scan).
- `src/action.ts` — GitHub Action entrypoint: reads inputs/env, runs the diff, writes the markdown report to `GITHUB_STEP_SUMMARY` and structured outputs to `GITHUB_OUTPUT`.
- `src/index.ts` — CLI entrypoint (`capabilityecho diff …`).
- `dist/` — **checked-in** TypeScript output and ncc-bundled action. The action runs from `dist/action-bundle/index.js`. CI verifies that `dist/` is up to date.
- `test/*.test.mjs` — node:test suites. `test/fixtures/bypasses/` is the corpus of patterns the detectors have been hardened against.
- Shared parsing / locators / `Finding` schema come from [`agent-gov-core`](https://github.com/Conalh/agent-gov-core).

## Detector contract

Every detector consumes `AddedLine[]` (one entry per added diff line) plus the full new-file contents map for full-file passes (e.g. secret-variable collection). They return `Finding`s tagged with a `capability_echo.*` kind, surface (`source`/`workflow`/`package`/`container`), severity, file, line (1-based or `undefined`), subject, message, and recommendation.

Line-level annotations matter — they drive the PR-visible warnings. Prefer key-first JSON locators (`lineOfJsonKey`) over value-first (`lineOfJsonStringValue`) because version strings collide across deps.

## Things to remember when editing detectors

- **Filter comments early.** The shared `isCommentLine` from `paths.ts` covers `// /* * #`. Any per-line detector loop should drop comment lines before pattern matching.
- **Gate same-line URL where you can.** The JS/Python network detectors require `https?://` on the same added line to keep false positives down. Split-line constructs are a documented detection limit (see README "Detection limits").
- **No cross-file taint.** A new call site that imports a URL or secret defined in an unchanged file is *not* tainted today. Don't bolt this on inside a single-surface detector — it belongs at the diff layer.
- **Excluded paths.** `.mcp.json`, `.claude/settings.json`, `.cursor/`, `.codex/`, `AGENTS.md`, etc. are deliberately out of scope — ScopeTrail and PolicyMesh own those. Don't add agent-config scanning here.
- **The action uploads nothing.** Don't introduce network calls in the action runtime. Step summaries and outputs are the only sinks.

## Build / test

```powershell
npm install
npm run build      # tsc + ncc bundle into dist/
npm test
```

`npm run build` is required after any `src/` change because `dist/` is the actual published runtime — both the CLI bin and the action entrypoint live there. CI checks for stale `dist/`.

## What CapabilityEcho is NOT

- It is **not** a config drift detector. Use [ScopeTrail](https://github.com/Conalh/ScopeTrail).
- It is **not** a cross-surface contradiction checker. Use [PolicyMesh](https://github.com/Conalh/PolicyMesh).
- It is **not** a runtime transcript reviewer. Use [SessionTrail](https://github.com/Conalh/SessionTrail).
- It is **not** a task-vs-diff scope checker. Use [TaskBound](https://github.com/Conalh/TaskBound).
