# Governance

Commonpost MCP for Thunderbird is a continuation of [thunderbird-mcp](https://github.com/TKasperczyk/thunderbird-mcp)
by Tomasz Kasperczyk, kept under its MIT license with its history. It lives in the
[commonpost](https://github.com/commonpost) GitHub organization: this repository, and the
[lab](https://github.com/commonpost/thunderbird-mcp-lab) that tests it in a real Thunderbird.

## Roles

| Role | Who | Can do |
|---|---|---|
| Maintainer | Guillaume Laforest ([@sacrefizz](https://github.com/sacrefizz)), owner of the organization | Merge pull requests, approve releases (the protected `release` environment), handle security reports and publish advisories, change repository settings |
| Contributor | Anyone | Open issues and pull requests, review them, report vulnerabilities privately ([SECURITY.md](SECURITY.md)) |
| Upstream | Tomasz Kasperczyk | Author of the original project; changes that fit it are offered there too ([CONTRIBUTING.md](CONTRIBUTING.md)) |

Today the project has **one maintainer**. A second one is welcome; see "Becoming a maintainer" below.

## How decisions are made

- Changes are proposed as pull requests, discussed in the pull request or in an issue, and merged by a maintainer once
  the required checks pass (tests on Node 22 and 24, ESLint, version sync, zizmor, CodeQL and the end-to-end lab). No
  change reaches `main` without a pull request.
- Larger changes (a new tool, a change in what the add-on is allowed to do, a new dependency, a change of license or
  of the update channel) start with an issue, so that users can comment before the work is done.
- Security decisions (what is a vulnerability, its severity, when to disclose) follow [SECURITY.md](SECURITY.md).
  They are made in private until a fix is released.
- With more than one maintainer, decisions are taken by consensus among the maintainers; if they cannot agree, the
  change waits.
- Releases follow [RELEASING.md](RELEASING.md). A release is published only after a maintainer approves the protected
  `release` environment; its files are rebuilt reproducibly and attested.

## Becoming a maintainer

A regular contributor whose pull requests have been merged over several months can be invited by the existing
maintainers, or can ask in an issue. A new maintainer gets write access first, then the rights to approve releases and
handle security reports. Maintainers must use two-factor authentication on GitHub.

## Continuity

The project is meant to survive the loss of any one person:

- The code, its full history, the issues and the release process are public. Anyone can fork the repository and
  continue it under the MIT license.
- Releases can be rebuilt byte for byte from any tag (`scripts/build-xpi-reproducible.cjs`,
  `scripts/build-mcpb-reproducible.cjs`), and [RELEASING.md](RELEASING.md) documents every step.
- No secret is needed to build or test. Publishing uses only GitHub's own token and attestations: no signing key or
  package registry account is held by a person.

Access to the `commonpost` organization (its repositories, the protected `release` environment and the update channel
on GitHub Pages, `updates.json`, which installed add-ons check for updates) is covered by a lockbox and a will: the
maintainer keeps sealed instructions and the credentials needed to sign in with their will and protection mandate.
If the maintainer dies, becomes unable to act or stops answering for a month, the person who opens them invites a
successor as owner of the organization within a week: first a maintainer or regular contributor, then the people
named in the instructions. If nobody accepts within 30 days, the repositories are archived, not deleted. A second
maintainer remains the better answer and is welcome.

## Changes to this document

This document changes through pull requests, like the code.
