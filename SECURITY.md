# Security Policy

## Reporting a vulnerability

**Please do not file public issues for security problems.**

Email the maintainer privately via the contact on
[naurolabs.com](https://naurolabs.com), or open a
[GitHub private security advisory](https://github.com/samoletovs/atlas/security/advisories/new).

We aim to acknowledge within 7 days and triage within 30.

## Scope

In scope:

- Authentication / authorization bypass (the `getPrincipal` / `requireOwner`
  flow in `api/src/shared/auth.ts`)
- Cosmos query injection
- Leakage of another user's lessons, repos, GitHub PATs, or BYOK keys
- Bypassing the per-user generation quota (`api/src/shared/quota.ts`)
- Bypassing the global daily AI budget cap (`api/src/shared/budget.ts`)
- Server-side request forgery via the GitHub URL parser
- XSS in the lesson reader (markdown rendering)
- Decryption oracle on stored secrets (`api/src/shared/crypto.ts`)

Out of scope:

- Denial of service via legitimate user behaviour (atlas has cost caps; rate
  limiting is a known trade-off, not a bug)
- Dependency vulnerabilities in `node_modules` with no demonstrated exploit
  path through atlas code
- Findings from automated scanners without a working PoC

## Disclosure

We follow coordinated disclosure. Once a fix ships we credit the reporter in
the release notes unless they prefer to stay anonymous.
