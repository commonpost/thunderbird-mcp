# Contributing

Thank you for helping. Contributions are welcome: bug fixes, tests, documentation, compatibility with new Thunderbird
versions, and moving functionality from the Experiment API to standard MailExtension APIs (see
[docs/experiment-inventory.md](docs/experiment-inventory.md)).

## Ground rules

1. **No vulnerability details in public before a fix.** Do not open a public issue, pull request or discussion that
   demonstrates an unfixed vulnerability. Report it privately, following [SECURITY.md](SECURITY.md).
2. **Synthetic data only.** Use reserved example domains (`example.com`, `example.test`, ...) and invented content in
   tests, issues and logs. Never include real messages, addresses, tokens, host names or paths from a real machine.
3. **Test what you change.** New functionality comes with a test in the same pull request; a bug fix comes with a test
   that fails without the fix whenever that is practical. Say in the pull request which tests you added.
4. **Pin what you add.** GitHub Actions by full commit SHA (with the version in a comment); npm dependencies through
   the committed `package-lock.json` (`npm ci --ignore-scripts`).
5. **Keep the privileged surface small.** Code that needs Thunderbird's full privileges stays in
   `extension/mcp_server/api.js` and `extension/httpd.sys.mjs`; do not add privileged calls elsewhere, and update
   [docs/experiment-inventory.md](docs/experiment-inventory.md) when you change what needs the Experiment.
6. **Be respectful of upstream.** This project continues thunderbird-mcp by Tomasz Kasperczyk and keeps its history.
   Where a change fits the original project, we offer it there too.
7. **License header in each source file.** A new source file starts (after any `#!` line) with the two SPDX lines the
   other files carry: `SPDX-License-Identifier: MIT` and `SPDX-FileCopyrightText: The thunderbird-mcp and Commonpost
   contributors (see LICENSE)`. `test/spdx-headers.test.cjs` checks it.

## Working locally

```sh
npm ci --ignore-scripts        # dev dependencies from the lockfile (Node.js 22 or later)
npm test                       # node --test test/*.cjs test/*.js
npm run lint                   # ESLint, strict: any warning fails (eslint.config.mjs)
node scripts/build-xpi-reproducible.cjs   # builds dist/commonpost-mcp-v<version>.xpi from the committed tree
```

Before changing how a tool composes, threads, searches or filters mail, see
[docs/thunderbird-internals.md](docs/thunderbird-internals.md) for how Thunderbird itself does it.

### Tests on a real Thunderbird

The unit tests run the code of `api.js` in Node with stubbed XPCOM; they cannot prove how Thunderbird behaves.
`npm run test:tb` (Linux x86-64, needs `curl`, `tar` and `node`) downloads a Thunderbird release into `.cache/`,
starts it headless with a throwaway profile under `.cache/tb-bench` (its own `HOME` and `TMPDIR`, so your own
Thunderbird and its `connection.json` are never touched), loads the synthetic mail in `test/fixtures/mail`, runs
`test/bench/*.test.cjs` through `mcp-bridge.cjs` and stops it again.

```sh
npm run test:tb                          # Thunderbird 156.0.1
TB_CHANNEL=esr npm run test:tb           # latest ESR (also esr-next, stable, beta); or TB_VERSION=140.16.0esr
scripts/tb-bench.sh start                # keep it running, then: node --test test/bench/reading.test.cjs
scripts/tb-bench.sh stop
```

Bench tests can also run privileged JavaScript in that Thunderbird through Marionette (`tb()` in
`test/bench/helpers.cjs`), for example to compare a tool's result with what Thunderbird's own compose window
produces. Without a running bench they are skipped.

**The bench is not a sandbox.** It runs Thunderbird with your own user permissions. While it is running, any
local process that can reach the Marionette port (`TB_BENCH_MARIONETTE_PORT`, default 2830) can execute
privileged JavaScript inside it; never run it against a real profile. Its synthetic accounts have no mail
server or SMTP, but Thunderbird itself still reaches Mozilla services over the network (e.g. Remote
Settings) -- it is not offline.

### End-to-end lab

Every pull request and every push to `main` also runs the
[thunderbird-mcp lab](https://github.com/commonpost/thunderbird-mcp-lab) (`.github/workflows/e2e-lab.yml`): the
extension and `mcp-bridge.cjs` of the tree run in a real Thunderbird inside an offline, disposable container, and the
lab checks what Thunderbird wrote (drafts, filter rules, `prefs.js`, messages delivered to a local SMTP sink). Only
the summary table is published; to see the logs, run the lab locally against your checkout, as its README explains.
A behaviour change that a lab scenario encodes needs a matching change in the lab repository.

To try the extension in Thunderbird, install the XPI from a release (Tools > Add-ons > Install Add-on From File).

## Small tasks for new contributors

Issues labelled [good first issue](https://github.com/commonpost/thunderbird-mcp/labels/good%20first%20issue) are small,
self-contained tasks that need no knowledge of Thunderbird's internals. Say in the issue that you are taking one, so
that two people do not do the same work.

## Reporting bugs and requesting features

Open an [issue](https://github.com/commonpost/thunderbird-mcp/issues): what you did, what you expected, what
happened, your Thunderbird version and operating system. Feature requests are welcome the same way. We aim to
acknowledge every report within 14 days. Security problems go through [SECURITY.md](SECURITY.md) instead, never
through a public issue.

## Pull requests

- Keep pull requests small and focused, in English.
- Say what you tested and what you only inferred.
- AI-assisted contributions are welcome if you have reviewed and run them yourself; please say so in the pull request.
  (Commits of the maintainers made with an AI assistant carry a `Co-Authored-By` trailer.)
- By contributing, you agree that your contribution is licensed under the MIT license of this repository.

## Code review

Every change reaches `main` through a pull request, and the
[required checks](GOVERNANCE.md#how-decisions-are-made) must pass before it is merged. The reviewer checks:

- **Behaviour:** the change does what the pull request says, and a test covers it (a bug fix: a test that fails
  without the fix, when practical). A change in what Thunderbird ends up doing is also checked in the end-to-end lab.
- **Security:** no new privileged call outside `api.js` and `httpd.sys.mjs`; the restrictions still hold (account
  restriction, refusal of encrypted content unless allowed, direct-send blocking, attachment path checks, the auth
  token); arguments from the assistant are validated; failures refuse rather than allow.
- **Data:** only synthetic data in tests, fixtures and logs.
- **Dependencies:** new ones are justified and pinned; GitHub Actions by commit SHA.
- **Documentation:** README and `CHANGELOG.md` (`[Unreleased]`) describe the change in the same pull request.

A pull request is merged when the checks pass and a maintainer approves it. A maintainer's own pull request needs the
approval of another maintainer; while the project has a single maintainer ([GOVERNANCE.md](GOVERNANCE.md)), the
required checks and the end-to-end lab are the second line of review.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
