# Contributing to CapabilityEcho

Thanks for helping make capability drift easier to review. Bug reports, false-positive reports, new regression fixtures, and focused detector improvements are all welcome.

## Set up the repository

CapabilityEcho requires Node.js 22 or newer.

```bash
git clone https://github.com/Conalh/CapabilityEcho.git
cd CapabilityEcho
npm ci
npm run build
npm test
npm run benchmark
```

The compiled `dist/` directory is checked in because both the CLI package and the JavaScript Action execute it. Run `npm run build` after changing `src/`, and include the resulting `dist/` changes in the same pull request.

## A good detector change

- Targets capability added by the diff, not behavior that already exists in the base.
- Produces an exact file and line whenever the input makes that possible.
- Filters comments and obvious benign near-misses before matching.
- Adds a focused test for the new signal and a benign counterexample when false positives are plausible.
- Updates the labeled benchmark only when the change represents a stable, intentional detector contract.
- Keeps agent configuration out of scope; ScopeTrail and PolicyMesh own that surface.

Please keep public claims proportional to the evidence. The benchmark is a committed regression corpus, not an independent real-world evaluation.

## Before opening a pull request

Run all four release gates:

```bash
npm run build
npm test
npm run benchmark
npm pack --dry-run
```

Then confirm `git diff --check` is clean and that every generated `dist/` change is intentional.

## Reporting security problems

Do not open a public issue for a vulnerability that could expose user data, execute untrusted code, bypass a documented trust boundary, or compromise the published Action or npm package. Follow [SECURITY.md](SECURITY.md) instead.
