# Bypass fixtures

Each subdirectory is a minimal `old/`/`new/` pair that demonstrates an evasion
pattern CapabilityEcho should now catch. They feed end-to-end CLI tests so the
detector wiring (added-line collection + cross-line tracking + reporting) is
exercised, not just the regex in isolation.

When closing a new bypass:

1. Add a minimal fixture pair under `bypasses/<short-name>/old/`, `bypasses/<short-name>/new/`.
2. Wire one CLI integration test that diffs the pair and asserts the expected `kind` fires.
3. Keep the file footprint tiny; one source file + `package.json` is usually enough.
