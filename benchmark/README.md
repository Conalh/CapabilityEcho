# CapabilityEcho benchmark

A labeled regression suite for CapabilityEcho's capability-drift detection. It
answers: **when an agent's PR adds a capability the obvious way, does
CapabilityEcho catch it — and does it stay quiet on ordinary changes?**

> **Read this as a specification and regression suite, not an evaluation against
> independent ground truth.** The detectors and these fixtures share an author, so
> a perfect score means the detectors behave to spec and keep doing so as the code
> changes — it does *not* show how well the tool generalizes to what real agents or
> adversaries produce, and each rogue case here is a single textbook pattern. For
> what the tool deliberately does and does not cover, see the README's
> [Threat model and limits](../README.md#threat-model-and-limits).

## Latest results

See [RESULTS.md](RESULTS.md) (regenerated on every run). Headline:

| Metric | Value |
| --- | --- |
| Cases | 34 (20 rogue, 14 benign) |
| Detection recall on this committed corpus (any finding) | 100.0% |
| False-positive rate on this committed benign corpus | 0.0% |
| Precision on this committed corpus | 100.0% |
| Recall at `--fail-on=high` CI gate | 85.0% |
| Correct primary capability identified | 20/20 |

Reproduce with `npm run benchmark` from the repo root.

## What's in the corpus

Each case is a **before/after snapshot of a single pull request** — the same
input shape CapabilityEcho sees in CI (`capabilityecho diff --old before --new
after`). Cases live under `fixtures/<class>/<id>/` with a `label.json` carrying
the ground truth.

**20 rogue cases** span every executable surface CapabilityEcho scans and every
severity tier:

- **Source (JS/TS + Python):** external `fetch`/`requests`, secret exfiltration
  over the network, subprocess spawns, `eval`, unsafe deserialization.
- **Shell:** `curl | bash`, external binary downloads.
- **Workflow:** `pull_request_target`, widened token permissions, secret-bearing
  `curl`, host Docker-socket mounts.
- **Container:** remote `ADD`, `RUN curl … | bash`.
- **Package:** high-capability dependency additions (e.g. `puppeteer`),
  `postinstall` lifecycle scripts, pipe-to-shell install scripts.
- **Multi-surface:** one PR that exfiltrates a secret *and* widens the CI token.

**14 benign cases** are deliberately adversarial near-misses — the changes most
likely to trip a naive scanner but which add no capability:

- Pure helper functions, refactors/renames, a new unit test, a new in-memory
  class.
- A **same-origin** `fetch('/api/...')` (relative, not external).
- `yaml.safe_load` (the safe counterpart to the flagged `yaml.load`).
- Docs-only changes, ordinary dependency additions (`date-fns`, `zod`), a
  version bump of an existing dep, non-lifecycle npm scripts.
- A standard CI workflow (read-only token, SHA-pinned action) and a standard
  Dockerfile (`COPY` + `npm ci`, no remote fetch).

## How scoring works

The runner invokes the built CLI per fixture in JSON mode and reads the
canonical report's `rating` and `findings[].kind`.

- **Prediction:** a diff is "drift" when its overall rating meets a threshold.
  `low` means *any finding at all*; `high` models a typical CI gate.
- **Ground truth:** rogue → should flag; benign → should not. Labels are written
  from each change's intent, **independent of what the tool emits** — a rogue
  case the tool misses counts as a false negative and shows up in the numbers.
- Reported per threshold: precision, recall, false-positive rate, F1, accuracy.
- **Capability identification:** for rogue cases the runner also checks whether
  the expected `kind`(s) appear, so a finding for the *wrong* reason doesn't
  count as a clean hit.
- **Regression gates:** the command exits nonzero if a rogue fixture is missed,
  a benign fixture is flagged, an expected kind or minimum severity is lost, the
  default corpus count drifts, or a runtime probe fails.
- **Runtime probes:** after the directory-mode corpus, the runner also checks a
  git-mode hostile-filename case and executes the actual bundled Action
  entrypoint at `dist/action-bundle/index.js`.

### Reading the threshold table

Recall is 100% at the `low`/`medium` gates and 85% at `high`. That gap is
**calibration, not a miss**: three rogue cases (an external `fetch`, a Python
`requests.get`, a `wget` download) are genuinely *medium*-severity capability
additions. A team gating on `--fail-on=high` is choosing to let medium signals
through; gate on `medium` to catch every rogue case in this corpus. Every case
is still detected (a finding is emitted) — the gate only decides what fails CI.

## Running it

```bash
npm run benchmark          # builds dist/, runs all fixtures, writes RESULTS.md
# or, if dist/ is already built:
node benchmark/run-benchmark.mjs
node benchmark/build-fixtures.mjs --check   # verify fixtures match generator
```

## Adding or changing cases

`build-fixtures.mjs` is the source of truth — every case is one entry in the
`cases` array (id, label, surface, expected kinds/severity, and the before/after
file maps). Edit it, then regenerate the materialized fixtures:

```bash
node benchmark/build-fixtures.mjs
```

Keep labels honest: set `expectKinds` to what the change *should* be flagged as,
then let the runner tell you whether the detector agrees.
