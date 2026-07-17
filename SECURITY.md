# Security policy

## Supported versions

Security fixes are applied to the latest published release. Users should pin the latest full GitHub Action tag or npm version and upgrade when a security release is published.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Conalh/CapabilityEcho/security/advisories/new) for this repository.

Include the affected version, operating system and Node.js version, a minimal reproduction, the impact you believe is possible, and any suggested mitigation. Please do not include secrets or private repository content in the report.

If private reporting is unavailable, open a public issue containing only a request for a private contact channel. Do not publish exploit details in that issue.

## Trust boundary

CapabilityEcho reads repository diffs and produces local or GitHub Actions output. It does not upload scanned source code or provide runtime containment. Exception policy is loaded from the trusted base revision; a candidate pull request cannot suppress its own findings by changing that policy.

The detector is designed to surface obvious capability drift from ordinary mistakes and AI-generated changes. It is not an adversarial malware scanner, sandbox, or proof that a clean diff is safe. See the README's threat model before using findings as a merge gate.
