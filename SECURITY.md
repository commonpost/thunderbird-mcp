# Security Policy

## Supported Versions

We support the latest released version of `commonpost-mcp`. Older
versions receive no fixes; the recommended path for any security
finding is to upgrade to the current release.

| Version  | Supported          |
| -------- | ------------------ |
| latest   | ✅                 |
| < latest | ❌                 |

## Reporting a Vulnerability

**Please do not file a public GitHub issue for security findings.**

Use GitHub's [private vulnerability reporting](https://github.com/commonpost/thunderbird-mcp/security/advisories/new)
on this repository. That route:

- keeps the report private until a fix is available,
- generates a CVE if appropriate,
- coordinates disclosure with downstream Thunderbird users.

Acknowledgement target: 72 hours. Triage and a first response on
severity + likely fix path: 7 days. Substantive fixes for confirmed
vulnerabilities ship as a patch release.

## What's in scope

This project bridges three trust boundaries; any of them is in scope:

1. **JSON-RPC over stdin** to `mcp-bridge.cjs`. Adversarial input
   includes malformed JSON, oversized payloads, control characters,
   prototype pollution attempts.
2. **HTTP transport** between the bridge and the Thunderbird
   extension (`http://localhost:<port>` with token auth). Token
   handling, timing-safe comparison, port-binding hygiene.
3. **Tool dispatch inside the extension** (`extension/mcp_server/api.js`).
   The permission engine + per-tool argument validation are the
   primary boundary. Any path that lets a caller exceed their
   declared permission scope, or that accesses Thunderbird state
   outside the permission's intent (e.g. reading another account's
   mailbox via a tool that should only see Inbox), is in scope.
4. **Native messaging / WebExtension experiment surface**. The
   extension runs in Thunderbird's chrome context with XPCOM
   privileges -- any path that leaks XPCOM capabilities to an
   unauthenticated caller is in scope.

## What's out of scope

- DoS against `mcp-bridge.cjs` from a process that already has
  local-user trust (the bridge runs in the user's session; that's
  the threat model's TCB by design).
- Behaviour of `npm audit` / `dependabot` flagged transitive deps
  unless there is a confirmed runtime-exploitable path. We ship
  no production npm `dependencies`; only devDeps are exposed.
- Pre-release / unmerged feature branches. Report against `main`
  or the latest release.

## Bridge and add-on versions

- The bridge announces itself on every request in the `X-Commonpost-Bridge` header (`<version>; packaging=<mcpb|file>`,
  optionally `; profile=<name>`). The header is **not a security boundary**: any program that holds the token can send
  any value. The token is the boundary.
- The add-on warns about bridges older than the version it recommends and can refuse bridges below a local **security
  floor** written in its code. The floor ships disarmed (`0.0.0`); there is no remote switch and no setting to bypass it:
  a floor reaches users only through an add-on update.
- Arming the floor refuses every tool call from clients that send no header: all bridges 0.11.0 or older, and programs
  that call the HTTP API directly without declaring themselves. It is announced in the release notes ("security floor")
  and in an advisory.
- A profile (`profile=`) is self-declared too. A future per-client tool set may only narrow what the global settings
  allow (effective = global settings ∩ profile); a client without a profile, or with an unknown one, gets the user's
  default set, never more than the global settings. Restrictions that matter belong in the global settings, not in a
  profile.
- Supported: the bridge of the latest release. Its version number is the release in which the bridge last changed, so
  it can be lower than the add-on's.

## Coordinated disclosure

We follow the Mozilla / Thunderbird coordinated-disclosure cadence
where the issue intersects upstream Thunderbird internals. If your
finding touches `nsIMsgSend`, `nsIMsgCompose`, or other XPCOM
interfaces, we may forward (with credit) to
[Mozilla's security team](https://www.mozilla.org/en-US/security/)
or open a Bugzilla report on your behalf. We'll always coordinate
disclosure timing with you before doing so.

## Recognition

Researchers who report verified vulnerabilities are credited in the
release notes for the patch release that fixes the issue, unless
they request to remain anonymous.