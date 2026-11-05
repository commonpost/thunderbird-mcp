# Roadmap

What the project intends to do over the next year (from November 2026). It is a plan, not a promise: priorities move
with Thunderbird's own changes, security reports and what users ask for in
[issues](https://github.com/commonpost/thunderbird-mcp/issues).

## Keep working on supported Thunderbird versions

- Support the current Release and ESR channels; Thunderbird ESR 153 is the long-term target.
- Thunderbird's Add-ons team has announced plans to stop running Experiment-API add-ons on the Release channel and to
  keep them on ESR. Until that happens, the add-on keeps running on both; if it happens, ESR stays supported (see
  "If Thunderbird disables Experiment add-ons" in the [README](README.md)).

## Shrink the privileged part

Follows the plan in [docs/experiment-inventory.md](docs/experiment-inventory.md):

1. Move what can move to standard MailExtension APIs, tool by tool, starting with folders, messages and contacts.
2. Replace the local HTTP port between the bridge and the add-on with native messaging.
3. Keep only what has no public API (calendar, filters, full-text search) as a small Experiment, or propose public
   APIs for it to the Thunderbird team.

## Security and supply chain

- Keep fixing reported vulnerabilities through private reports and published advisories ([SECURITY.md](SECURITY.md)).
- Keep the release files reproducible and attested, and pinned dependencies up to date.
- Reach the OpenSSF Best Practices silver level.
- Find a second maintainer, so that pull requests get a second reviewer and the project no longer depends on one
  person ([GOVERNANCE.md](GOVERNANCE.md)).

## Features under consideration

- Attachment search that also finds attachments inside signed messages (today Thunderbird does not flag them as
  having attachments, so they are not searched).
- Further options on existing tools rather than new tools: the tool list is kept to about 40 tools (41 since
  `deleteTask`) so that assistants can choose among them reliably.
- An optional bridge setting to expose only some domains of tools (for example mail only), for models with a small
  context; the default stays all tools.

Ideas and requests are welcome as issues.
