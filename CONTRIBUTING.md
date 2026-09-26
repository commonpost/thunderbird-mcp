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

## Working locally

```sh
npm ci --ignore-scripts        # dev dependencies from the lockfile
npm test                       # node --test test/*.cjs
npm run lint                   # ESLint
node scripts/build-xpi-reproducible.cjs   # builds dist/commonpost-mcp-v<version>.xpi from the committed tree
```

To try the extension in Thunderbird, install the XPI from a release (Tools > Add-ons > Install Add-on From File).

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

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
